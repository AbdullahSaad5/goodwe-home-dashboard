#include <algorithm>
#include <array>
#include <atomic>
#include <cerrno>
#include <cstdio>
#include <ctime>
#include <cstring>
#include <dirent.h>
#include <optional>
#include <string>
#include <sys/socket.h>
#include <sys/stat.h>
#include <vector>
#include <unistd.h>

#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_littlefs.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_sntp.h"
#include "esp_system.h"
#include "esp_task_wdt.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "goodwe_protocol.hpp"
#include "gwr1.hpp"
#include "lwip/inet.h"
#include "lwip/sockets.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "psa/crypto.h"
#include "zlib.h"

namespace {

constexpr char tag[] = "goodwe_collector";
constexpr char archive_root[] = "/archive";
constexpr std::size_t archive_batch_size = 1;
constexpr std::uint64_t sequence_reservation_size = 30;
constexpr TickType_t poll_interval = pdMS_TO_TICKS(10'000);
constexpr EventBits_t wifi_connected = BIT0;
EventGroupHandle_t wifi_events;
QueueHandle_t sample_queue;
SemaphoreHandle_t inverter_mutex;
TaskHandle_t upload_task_handle;

struct Config {
  std::string ssid;
  std::string password;
  std::string configured_address;
  std::string ingest_url;
  std::string device_id;
  std::string device_secret;
  std::array<std::uint8_t, 16> device_id_bytes{};
  std::array<std::uint8_t, 32> decoder_hash{};
};

struct Poll {
  std::uint64_t utc_ms{};
  std::uint64_t sequence{};
  std::uint16_t flags{};
  std::uint8_t timestamp_source{};
  std::array<std::vector<std::uint8_t>, 3> frames;
};

Config config;
std::string inverter_address;
std::atomic<std::uint64_t> next_sequence{};
std::atomic<std::uint64_t> reserved_end{};
std::atomic<bool> clock_synchronized{};
std::vector<std::uint8_t> device_info_frame;

void time_sync_notification(timeval*) {
  if (!clock_synchronized.exchange(true)) {
    ESP_LOGI(tag, "Network time synchronization completed");
  }
}

void record_dropped_range(const std::uint64_t first, const std::uint64_t last) {
  nvs_handle_t handle;
  if (nvs_open("collector", NVS_READWRITE, &handle) != ESP_OK) return;
  std::uint64_t stored_first = first;
  std::uint64_t stored_last = last;
  std::uint64_t previous_first = 0;
  std::uint64_t previous_last = 0;
  if (nvs_get_u64(handle, "dropped_first", &previous_first) == ESP_OK &&
      nvs_get_u64(handle, "dropped_last", &previous_last) == ESP_OK) {
    stored_first = std::min(stored_first, previous_first);
    stored_last = std::max(stored_last, previous_last);
  }
  nvs_set_u64(handle, "dropped_first", stored_first);
  nvs_set_u64(handle, "dropped_last", stored_last);
  nvs_commit(handle);
  nvs_close(handle);
}

std::string nvs_string(nvs_handle_t handle, const char* key) {
  std::size_t length = 0;
  if (nvs_get_str(handle, key, nullptr, &length) != ESP_OK || length < 2) return {};
  std::string value(length, '\0');
  if (nvs_get_str(handle, key, value.data(), &length) != ESP_OK) return {};
  value.resize(length - 1);
  return value;
}

bool hex_bytes(const std::string& input, std::uint8_t* output, const std::size_t length) {
  if (input.size() != length * 2) return false;
  for (std::size_t index = 0; index < length; ++index) {
    unsigned value = 0;
    if (std::sscanf(input.substr(index * 2, 2).c_str(), "%02x", &value) != 1) return false;
    output[index] = static_cast<std::uint8_t>(value);
  }
  return true;
}

bool load_config() {
  nvs_handle_t handle;
  if (nvs_open("provision", NVS_READONLY, &handle) != ESP_OK) return false;
  config.ssid = nvs_string(handle, "wifi_ssid");
  config.password = nvs_string(handle, "wifi_password");
  config.configured_address = nvs_string(handle, "inverter_addr");
  config.ingest_url = nvs_string(handle, "ingest_url");
  config.device_id = nvs_string(handle, "device_id");
  config.device_secret = nvs_string(handle, "device_secret");
  const auto decoder = nvs_string(handle, "decoder_hash");
  std::string compact_id;
  for (const char character : config.device_id) {
    if (character != '-') compact_id += character;
  }
  const bool valid = !config.ssid.empty() && !config.password.empty() &&
                     !config.ingest_url.empty() && config.device_secret.size() >= 32 &&
                     hex_bytes(compact_id, config.device_id_bytes.data(), config.device_id_bytes.size()) &&
                     hex_bytes(decoder, config.decoder_hash.data(), config.decoder_hash.size());
  nvs_close(handle);
  return valid;
}

void wifi_handler(void*, esp_event_base_t base, std::int32_t id, void* data) {
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) esp_wifi_connect();
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
    const auto* disconnected = static_cast<const wifi_event_sta_disconnected_t*>(data);
    ESP_LOGW(tag, "Wi-Fi disconnected (reason %u)",
             disconnected == nullptr ? 0U : static_cast<unsigned>(disconnected->reason));
    xEventGroupClearBits(wifi_events, wifi_connected);
    esp_wifi_connect();
  }
  if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
    ESP_LOGI(tag, "Wi-Fi connected and received an address");
    xEventGroupSetBits(wifi_events, wifi_connected);
    if (esp_sntp_enabled() && !esp_sntp_restart()) {
      ESP_LOGW(tag, "Unable to restart network time synchronization");
    }
  }
}

void start_wifi() {
  wifi_events = xEventGroupCreate();
  ESP_ERROR_CHECK(esp_netif_init());
  ESP_ERROR_CHECK(esp_event_loop_create_default());
  esp_netif_create_default_wifi_sta();
  wifi_init_config_t initialization = WIFI_INIT_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(esp_wifi_init(&initialization));
  ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_handler, nullptr));
  ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_handler, nullptr));
  wifi_config_t station{};
  std::strncpy(reinterpret_cast<char*>(station.sta.ssid), config.ssid.c_str(), sizeof(station.sta.ssid));
  std::strncpy(reinterpret_cast<char*>(station.sta.password), config.password.c_str(), sizeof(station.sta.password));
  station.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
  ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
  ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &station));
  ESP_ERROR_CHECK(esp_wifi_start());
}

std::optional<std::vector<std::uint8_t>> read_frame(const std::string& address,
                                                    const std::uint16_t transaction,
                                                    const goodwe_protocol::ReadRange range,
                                                    const int timeout_ms = 900) {
  const int socket_fd = socket(AF_INET, SOCK_STREAM, IPPROTO_IP);
  if (socket_fd < 0) return std::nullopt;
  timeval timeout{timeout_ms / 1000, (timeout_ms % 1000) * 1000};
  setsockopt(socket_fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
  setsockopt(socket_fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
  sockaddr_in destination{};
  destination.sin_family = AF_INET;
  destination.sin_port = htons(502);
  if (inet_pton(AF_INET, address.c_str(), &destination.sin_addr) != 1 ||
      connect(socket_fd, reinterpret_cast<sockaddr*>(&destination), sizeof(destination)) != 0) {
    close(socket_fd);
    return std::nullopt;
  }
  const auto request = goodwe_protocol::make_read_request(transaction, range);
  if (send(socket_fd, request.data(), request.size(), 0) != static_cast<int>(request.size())) {
    close(socket_fd);
    return std::nullopt;
  }
  const auto definition = goodwe_protocol::definition(range);
  std::vector<std::uint8_t> response(9 + definition.register_count * 2);
  std::size_t received = 0;
  while (received < response.size()) {
    const int count = recv(socket_fd, response.data() + received, response.size() - received, 0);
    if (count <= 0) break;
    received += static_cast<std::size_t>(count);
  }
  close(socket_fd);
  if (received != response.size() || !goodwe_protocol::validate_read_response(response, transaction, range)) {
    return std::nullopt;
  }
  return response;
}

bool validate_candidate(const std::string& address) {
  const auto response = read_frame(address, 1, goodwe_protocol::ReadRange::device_info, 500);
  if (!response) return false;
  device_info_frame = *response;
  return true;
}

std::optional<std::string> discover_broadcast() {
  const int socket_fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (socket_fd < 0) return std::nullopt;
  int enabled = 1;
  setsockopt(socket_fd, SOL_SOCKET, SO_BROADCAST, &enabled, sizeof(enabled));
  timeval timeout{1, 0};
  setsockopt(socket_fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
  sockaddr_in destination{};
  destination.sin_family = AF_INET;
  destination.sin_port = htons(48899);
  destination.sin_addr.s_addr = INADDR_BROADCAST;
  constexpr char discovery[] = "WIFIKIT-214028-READ";
  sendto(socket_fd, discovery, sizeof(discovery) - 1, 0,
         reinterpret_cast<sockaddr*>(&destination), sizeof(destination));
  std::array<char, 192> response{};
  const int length = recv(socket_fd, response.data(), response.size() - 1, 0);
  close(socket_fd);
  if (length <= 0) return std::nullopt;
  const std::string message(response.data(), static_cast<std::size_t>(length));
  const auto comma = message.find(',');
  const auto candidate = message.substr(0, comma);
  in_addr parsed{};
  if (comma == std::string::npos || inet_pton(AF_INET, candidate.c_str(), &parsed) != 1) return std::nullopt;
  return validate_candidate(candidate) ? std::optional(candidate) : std::nullopt;
}

std::optional<std::string> scan_subnet() {
  esp_netif_ip_info_t ip{};
  esp_netif_t* interface = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
  if (!interface || esp_netif_get_ip_info(interface, &ip) != ESP_OK) return std::nullopt;
  const std::uint32_t local = ntohl(ip.ip.addr);
  const std::uint32_t base = local & 0xffffff00U;
  for (std::uint32_t host = 1; host < 255; ++host) {
    const std::uint32_t candidate_value = base | host;
    if (candidate_value == local) continue;
    in_addr candidate_address{htonl(candidate_value)};
    std::array<char, INET_ADDRSTRLEN> candidate{};
    inet_ntop(AF_INET, &candidate_address, candidate.data(), candidate.size());
    if (validate_candidate(candidate.data())) return std::string(candidate.data());
    vTaskDelay(pdMS_TO_TICKS(5));
  }
  return std::nullopt;
}

std::optional<std::string> locate_inverter() {
  if (!config.configured_address.empty() && validate_candidate(config.configured_address)) {
    return config.configured_address;
  }
  nvs_handle_t handle;
  if (nvs_open("collector", NVS_READWRITE, &handle) == ESP_OK) {
    const auto previous = nvs_string(handle, "last_inverter");
    nvs_close(handle);
    if (!previous.empty() && validate_candidate(previous)) return previous;
  }
  if (auto result = discover_broadcast()) return result;
  return scan_subnet();
}

void save_validated_address(const std::string& address) {
  nvs_handle_t handle;
  if (nvs_open("collector", NVS_READWRITE, &handle) != ESP_OK) return;
  nvs_set_str(handle, "last_inverter", address.c_str());
  if (!device_info_frame.empty()) {
    nvs_set_blob(handle, "device_info", device_info_frame.data(), device_info_frame.size());
  }
  nvs_commit(handle);
  nvs_close(handle);
}

std::string current_inverter_address() {
  xSemaphoreTake(inverter_mutex, portMAX_DELAY);
  const auto address = inverter_address;
  xSemaphoreGive(inverter_mutex);
  return address;
}

void set_inverter_address(const std::string& address) {
  xSemaphoreTake(inverter_mutex, portMAX_DELAY);
  inverter_address = address;
  xSemaphoreGive(inverter_mutex);
}

void clear_inverter_address(const std::string& failed_address) {
  xSemaphoreTake(inverter_mutex, portMAX_DELAY);
  if (inverter_address == failed_address) inverter_address.clear();
  xSemaphoreGive(inverter_mutex);
}

void discovery_task(void*) {
  for (;;) {
    if ((xEventGroupGetBits(wifi_events) & wifi_connected) != 0 &&
        current_inverter_address().empty()) {
      if (const auto found = locate_inverter()) {
        set_inverter_address(*found);
        save_validated_address(*found);
        ESP_LOGI(tag, "Validated the inverter connection");
      }
    }
    vTaskDelay(pdMS_TO_TICKS(30'000));
  }
}

std::uint64_t allocate_sequence() {
  auto next = next_sequence.load();
  if (next >= reserved_end.load()) {
    nvs_handle_t handle;
    ESP_ERROR_CHECK(nvs_open("collector", NVS_READWRITE, &handle));
    std::uint64_t stored = 0;
    nvs_get_u64(handle, "reserved_end", &stored);
    next = std::max(next, stored);
    const auto end = next + sequence_reservation_size;
    ESP_ERROR_CHECK(nvs_set_u64(handle, "reserved_end", end));
    ESP_ERROR_CHECK(nvs_commit(handle));
    nvs_close(handle);
    next_sequence.store(next);
    reserved_end.store(end);
  }
  next_sequence.store(next + 1);
  return next;
}

void poll_task(void*) {
  ESP_ERROR_CHECK(esp_task_wdt_add(nullptr));
  std::uint16_t transaction = 100;
  bool waiting_for_time = false;
  bool first_sample_queued = false;
  TickType_t next_wake = xTaskGetTickCount();
  for (;;) {
    xTaskDelayUntil(&next_wake, poll_interval);
    ESP_ERROR_CHECK(esp_task_wdt_reset());
    const auto sequence = allocate_sequence();
    if ((xEventGroupGetBits(wifi_events) & wifi_connected) == 0) {
      record_dropped_range(sequence, sequence);
      continue;
    }
    const auto address = current_inverter_address();
    if (address.empty()) {
      record_dropped_range(sequence, sequence);
      continue;
    }
    const auto runtime = read_frame(address, transaction++, goodwe_protocol::ReadRange::runtime);
    const auto battery = read_frame(address, transaction++, goodwe_protocol::ReadRange::battery);
    const auto meter = read_frame(address, transaction++, goodwe_protocol::ReadRange::meter);
    if (!runtime || !battery || !meter) {
      ESP_LOGW(tag, "A telemetry frame read failed; rediscovering the inverter");
      record_dropped_range(sequence, sequence);
      clear_inverter_address(address);
      continue;
    }
    if (!clock_synchronized.load()) {
      if (!waiting_for_time) {
        ESP_LOGW(tag, "Waiting for network time synchronization before archiving telemetry");
        waiting_for_time = true;
      }
      record_dropped_range(sequence, sequence);
      continue;
    }
    waiting_for_time = false;
    auto sample = new Poll();
    sample->utc_ms = static_cast<std::uint64_t>(time(nullptr)) * 1000ULL;
    sample->timestamp_source = 1;
    sample->sequence = sequence;
    sample->frames = {*runtime, *battery, *meter};
    if (xQueueSend(sample_queue, &sample, 0) != pdTRUE) {
      ESP_LOGW(tag, "The telemetry archive queue is full");
      record_dropped_range(sample->sequence, sample->sequence);
      delete sample;
    } else if (!first_sample_queued) {
      ESP_LOGI(tag, "Queued the first complete telemetry sample");
      first_sample_queued = true;
    }
  }
}

std::vector<std::uint8_t> compress_archive(const std::vector<std::uint8_t>& input) {
  std::vector<std::uint8_t> output(compressBound(input.size()));
  z_stream stream{};
  constexpr int window_bits = 12;
  constexpr int memory_level = 4;
  if (deflateInit2(&stream, 1, Z_DEFLATED, window_bits, memory_level, Z_DEFAULT_STRATEGY) != Z_OK) {
    return {};
  }
  stream.next_in = const_cast<Bytef*>(input.data());
  stream.avail_in = static_cast<uInt>(input.size());
  stream.next_out = output.data();
  stream.avail_out = static_cast<uInt>(output.size());
  const int result = deflate(&stream, Z_FINISH);
  const auto output_length = stream.total_out;
  deflateEnd(&stream);
  if (result != Z_STREAM_END) return {};
  output.resize(output_length);
  return output;
}

bool write_batch(const std::vector<Poll>& polls) {
  if (polls.empty()) return false;
  gwr1::Archive archive;
  archive.device_id = config.device_id_bytes;
  archive.inverter_family = 1;
  archive.transport = 1;
  archive.decoder_hash = config.decoder_hash;
  archive.firmware_version = "1.0.0";
  archive.first_utc_ms = polls.front().utc_ms;
  archive.first_sequence = polls.front().sequence;
  archive.expected_interval_ms = 10'000;
  for (const auto& poll : polls) {
    archive.samples.push_back({
        poll.utc_ms - archive.first_utc_ms,
        poll.sequence - archive.first_sequence,
        poll.flags,
        poll.timestamp_source,
        {poll.frames[0], poll.frames[1], poll.frames[2]},
    });
  }
  const auto compressed = compress_archive(gwr1::encode(archive));
  if (compressed.empty()) {
    ESP_LOGE(tag, "Unable to compress a completed telemetry batch");
    record_dropped_range(polls.front().sequence, polls.back().sequence);
    return false;
  }
  char path[160];
  std::snprintf(path, sizeof(path), "%s/%020llu-%020llu.gwr.zlib", archive_root,
                static_cast<unsigned long long>(polls.front().sequence),
                static_cast<unsigned long long>(polls.back().sequence));
  const std::string temporary_path = std::string(path) + ".tmp";
  if (access(path, F_OK) == 0) return true;
  FILE* file = std::fopen(temporary_path.c_str(), "wb");
  if (!file || std::fwrite(compressed.data(), 1, compressed.size(), file) != compressed.size()) {
    ESP_LOGE(tag, "Unable to write a completed telemetry batch to LittleFS");
    if (file) std::fclose(file);
    std::remove(temporary_path.c_str());
    record_dropped_range(polls.front().sequence, polls.back().sequence);
    return false;
  }
  const bool synced = std::fflush(file) == 0 && fsync(fileno(file)) == 0;
  const bool closed = std::fclose(file) == 0;
  if (!synced || !closed) {
    ESP_LOGE(tag, "Unable to durably synchronize a completed telemetry batch");
    std::remove(temporary_path.c_str());
    record_dropped_range(polls.front().sequence, polls.back().sequence);
    return false;
  }
  if (std::rename(temporary_path.c_str(), path) != 0) {
    ESP_LOGE(tag, "Unable to atomically finalize a completed telemetry batch");
    std::remove(temporary_path.c_str());
    record_dropped_range(polls.front().sequence, polls.back().sequence);
    return false;
  } else {
    ESP_LOGI(tag, "Archived a telemetry batch with %u samples",
             static_cast<unsigned>(polls.size()));
    if (upload_task_handle) xTaskNotifyGive(upload_task_handle);
    return true;
  }
}

void archive_task(void*) {
  std::vector<Poll> batch;
  batch.reserve(archive_batch_size);
  ESP_LOGI(tag, "Telemetry archive task started");
  for (;;) {
    Poll* poll = nullptr;
    if (xQueueReceive(sample_queue, &poll, portMAX_DELAY) != pdTRUE || !poll) continue;
    batch.push_back(std::move(*poll));
    delete poll;
    if (batch.size() == archive_batch_size) {
      write_batch(batch);
      batch.clear();
    }
  }
}

std::string sha256_hex(const std::vector<std::uint8_t>& bytes) {
  std::array<unsigned char, 32> digest{};
  std::size_t digest_length = 0;
  if (psa_hash_compute(PSA_ALG_SHA_256, bytes.data(), bytes.size(), digest.data(), digest.size(),
                       &digest_length) != PSA_SUCCESS || digest_length != digest.size()) {
    return {};
  }
  char output[65]{};
  for (std::size_t index = 0; index < digest.size(); ++index) {
    std::snprintf(output + index * 2, 3, "%02x", digest[index]);
  }
  return output;
}

std::string hmac_hex(const std::string& value) {
  std::array<unsigned char, 32> digest{};
  psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT;
  psa_set_key_usage_flags(&attributes, PSA_KEY_USAGE_SIGN_MESSAGE);
  psa_set_key_algorithm(&attributes, PSA_ALG_HMAC(PSA_ALG_SHA_256));
  psa_set_key_type(&attributes, PSA_KEY_TYPE_HMAC);
  psa_set_key_bits(&attributes, config.device_secret.size() * 8);
  psa_key_id_t key{};
  if (psa_import_key(&attributes,
                     reinterpret_cast<const std::uint8_t*>(config.device_secret.data()),
                     config.device_secret.size(), &key) != PSA_SUCCESS) {
    psa_reset_key_attributes(&attributes);
    return {};
  }
  std::size_t digest_length = 0;
  const auto status = psa_mac_compute(key, PSA_ALG_HMAC(PSA_ALG_SHA_256),
                                      reinterpret_cast<const std::uint8_t*>(value.data()), value.size(),
                                      digest.data(), digest.size(), &digest_length);
  psa_destroy_key(key);
  psa_reset_key_attributes(&attributes);
  if (status != PSA_SUCCESS || digest_length != digest.size()) return {};
  char output[65]{};
  for (std::size_t index = 0; index < digest.size(); ++index) {
    std::snprintf(output + index * 2, 3, "%02x", digest[index]);
  }
  return output;
}

struct HttpResponseCapture {
  std::string body;
};

esp_err_t capture_http_response(esp_http_client_event_t* event) {
  if (event->event_id == HTTP_EVENT_ON_DATA && event->user_data && event->data && event->data_len > 0) {
    auto* capture = static_cast<HttpResponseCapture*>(event->user_data);
    capture->body.append(static_cast<const char*>(event->data), event->data_len);
  }
  return ESP_OK;
}

std::optional<std::string> json_string(const std::string& body, const std::string& key) {
  const std::string prefix = "\"" + key + "\":\"";
  const auto start = body.find(prefix);
  if (start == std::string::npos) return std::nullopt;
  const auto value_start = start + prefix.size();
  const auto end = body.find('"', value_start);
  if (end == std::string::npos) return std::nullopt;
  return body.substr(value_start, end - value_start);
}

bool upload_file(const std::string& path, const std::string& name) {
  if (time(nullptr) < 1'700'000'000) return false;
  FILE* file = std::fopen(path.c_str(), "rb");
  if (!file) return false;
  std::fseek(file, 0, SEEK_END);
  const long length = std::ftell(file);
  std::rewind(file);
  if (length <= 0) {
    std::fclose(file);
    return false;
  }
  std::vector<std::uint8_t> body(static_cast<std::size_t>(length));
  if (std::fread(body.data(), 1, body.size(), file) != body.size()) {
    std::fclose(file);
    return false;
  }
  std::fclose(file);
  unsigned long long first = 0, last = 0;
  if (std::sscanf(name.c_str(), "%llu-%llu.gwr.zlib", &first, &last) != 2) return false;
  const auto timestamp = std::to_string(static_cast<unsigned long long>(time(nullptr)));
  const auto hash = sha256_hex(body);
  const std::string canonical = "GWI1\nPOST\n/ingest/v1/batches\n" + config.device_id + "\n" +
                                std::to_string(first) + "\n" + std::to_string(last) + "\n" +
                                timestamp + "\n" + hash;
  const auto authorization = "HMAC v1=" + hmac_hex(canonical);
  HttpResponseCapture response;
  esp_http_client_config_t http_config{};
  http_config.url = config.ingest_url.c_str();
  http_config.method = HTTP_METHOD_POST;
  http_config.timeout_ms = 15'000;
  http_config.crt_bundle_attach = esp_crt_bundle_attach;
  http_config.event_handler = capture_http_response;
  http_config.user_data = &response;
  esp_http_client_handle_t client = esp_http_client_init(&http_config);
  if (!client) return false;
  esp_http_client_set_header(client, "Content-Type", "application/octet-stream");
  esp_http_client_set_header(client, "X-Device-ID", config.device_id.c_str());
  const auto first_text = std::to_string(first);
  const auto last_text = std::to_string(last);
  esp_http_client_set_header(client, "X-First-Sequence", first_text.c_str());
  esp_http_client_set_header(client, "X-Last-Sequence", last_text.c_str());
  esp_http_client_set_header(client, "X-Timestamp", timestamp.c_str());
  esp_http_client_set_header(client, "X-Body-SHA256", hash.c_str());
  esp_http_client_set_header(client, "Authorization", authorization.c_str());
  esp_http_client_set_post_field(client, reinterpret_cast<const char*>(body.data()), body.size());
  const esp_err_t result = esp_http_client_perform(client);
  const int status = esp_http_client_get_status_code(client);
  esp_http_client_cleanup(client);
  const bool accepted = result == ESP_OK && (status == 200 || status == 201) &&
                        json_string(response.body, "firstSequence") == std::optional(first_text) &&
                        json_string(response.body, "lastSequence") == std::optional(last_text) &&
                        json_string(response.body, "bodySha256") == std::optional(hash);
  if (accepted) {
    ESP_LOGI(tag, "Cloud acknowledged a telemetry batch");
  } else {
    ESP_LOGW(tag, "Telemetry upload failed (transport %s, HTTP %d)",
             esp_err_to_name(result), status);
  }
  return accepted;
}

void upload_task(void*) {
  std::uint32_t retry_delay_ms = 15'000;
  for (;;) {
    bool failed = false;
    if ((xEventGroupGetBits(wifi_events) & wifi_connected) != 0) {
      DIR* directory = opendir(archive_root);
      if (directory) {
        std::vector<std::string> names;
        while (const dirent* entry = readdir(directory)) {
          const std::string name(entry->d_name);
          constexpr char suffix[] = ".gwr.zlib";
          if (name.size() >= sizeof(suffix) - 1 &&
              name.compare(name.size() - (sizeof(suffix) - 1), sizeof(suffix) - 1, suffix) == 0) {
            names.push_back(name);
          }
        }
        closedir(directory);
        std::sort(names.begin(), names.end());
        for (const auto& name : names) {
          const auto path = std::string(archive_root) + "/" + name;
          if (upload_file(path, name)) {
            std::remove(path.c_str());
            retry_delay_ms = 15'000;
          } else {
            failed = true;
            break;
          }
        }
      }
    }
    if (failed) retry_delay_ms = std::min<std::uint32_t>(retry_delay_ms * 2, 900'000);
    const auto jitter_ms = esp_random() % 5'001;
    ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(retry_delay_ms + jitter_ms));
  }
}

void mount_archive() {
  esp_vfs_littlefs_conf_t filesystem{};
  filesystem.base_path = archive_root;
  filesystem.partition_label = "archive";
  filesystem.format_if_mount_failed = false;
  filesystem.dont_mount = false;
  ESP_ERROR_CHECK(esp_vfs_littlefs_register(&filesystem));
  DIR* directory = opendir(archive_root);
  if (!directory) return;
  while (const dirent* entry = readdir(directory)) {
    const std::string name(entry->d_name);
    if (name.size() >= 4 && name.compare(name.size() - 4, 4, ".tmp") == 0) {
      std::remove((std::string(archive_root) + "/" + name).c_str());
    }
  }
  closedir(directory);
}

}  // namespace

extern "C" void app_main() {
  ESP_ERROR_CHECK(nvs_flash_init());
  if (psa_crypto_init() != PSA_SUCCESS) {
    ESP_LOGE(tag, "Cryptographic subsystem initialization failed");
    return;
  }
  if (!load_config()) {
    ESP_LOGE(tag, "Device is not provisioned; run the local provisioning tool");
    return;
  }
  mount_archive();
  start_wifi();
  esp_sntp_setoperatingmode(SNTP_OPMODE_POLL);
  esp_sntp_setservername(0, const_cast<char*>("pool.ntp.org"));
  esp_sntp_set_time_sync_notification_cb(time_sync_notification);
  esp_sntp_init();
  sample_queue = xQueueCreate(36, sizeof(Poll*));
  inverter_mutex = xSemaphoreCreateMutex();
  ESP_ERROR_CHECK(sample_queue && inverter_mutex ? ESP_OK : ESP_ERR_NO_MEM);
  ESP_ERROR_CHECK(xTaskCreate(discovery_task, "discovery", 6144, nullptr, 5, nullptr) == pdPASS
                      ? ESP_OK
                      : ESP_ERR_NO_MEM);
  ESP_ERROR_CHECK(xTaskCreate(upload_task, "upload", 10'240, nullptr, 4, &upload_task_handle) == pdPASS
                      ? ESP_OK
                      : ESP_ERR_NO_MEM);
  ESP_ERROR_CHECK(xTaskCreate(archive_task, "archive", 10'240, nullptr, 6, nullptr) == pdPASS
                      ? ESP_OK
                      : ESP_ERR_NO_MEM);
  ESP_ERROR_CHECK(xTaskCreate(poll_task, "goodwe_poll", 8192, nullptr, 8, nullptr) == pdPASS
                      ? ESP_OK
                      : ESP_ERR_NO_MEM);
}
