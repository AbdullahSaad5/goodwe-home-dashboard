#include "gwr1.hpp"

#include <array>
#include <cassert>
#include <cstdint>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

std::string hex(const std::vector<std::uint8_t>& bytes) {
  std::ostringstream output;
  for (const auto byte : bytes) {
    output << std::hex << std::setfill('0') << std::setw(2) << static_cast<int>(byte);
  }
  return output.str();
}

std::vector<std::uint8_t> from_hex(const std::string& value) {
  std::vector<std::uint8_t> bytes;
  for (std::size_t offset = 0; offset < value.size(); offset += 2) {
    bytes.push_back(static_cast<std::uint8_t>(std::stoul(value.substr(offset, 2), nullptr, 16)));
  }
  return bytes;
}

constexpr auto expected_hex =
    "4757523101000062000102030405060708090a0b0c0d0e0f0101"
    "a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf"
    "312e322e3300000000000000000000000000018bcfe56800000000000000002a"
    "00002710000100000000000101020004000102030002feff00000072c10e613d";

gwr1::Archive fixture() {
  gwr1::Archive archive;
  for (std::size_t index = 0; index < archive.device_id.size(); ++index) {
    archive.device_id[index] = static_cast<std::uint8_t>(index);
  }
  for (std::size_t index = 0; index < archive.decoder_hash.size(); ++index) {
    archive.decoder_hash[index] = static_cast<std::uint8_t>(0xa0 + index);
  }
  archive.inverter_family = 1;
  archive.transport = 1;
  archive.firmware_version = "1.2.3";
  archive.first_utc_ms = 1'700'000'000'000ULL;
  archive.first_sequence = 42;
  archive.expected_interval_ms = 10'000;
  archive.samples = {{0, 0, 1, 1, {{0, 1, 2, 3}, {0xfe, 0xff}}}};
  return archive;
}

}  // namespace

int main() {
  const auto encoded = gwr1::encode(fixture());
  assert(hex(encoded) == expected_hex);

  const auto decoded = gwr1::decode(from_hex(expected_hex));
  assert(decoded == fixture());

  auto corrupted = from_hex(expected_hex);
  corrupted.at(105) ^= 0xff;
  try {
    static_cast<void>(gwr1::decode(corrupted));
    assert(false && "corrupt archive must be rejected");
  } catch (const std::runtime_error& error) {
    assert(std::string(error.what()).find("CRC32") != std::string::npos);
  }
}
