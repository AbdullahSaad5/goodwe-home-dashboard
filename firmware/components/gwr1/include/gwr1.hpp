#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace gwr1 {

struct Sample {
  std::uint64_t timestamp_delta_ms{};
  std::uint64_t sequence_delta{};
  std::uint16_t status_flags{};
  std::uint8_t timestamp_source{};
  std::vector<std::vector<std::uint8_t>> frames;

  bool operator==(const Sample&) const = default;
};

struct Archive {
  std::array<std::uint8_t, 16> device_id{};
  std::uint8_t inverter_family{};
  std::uint8_t transport{};
  std::array<std::uint8_t, 32> decoder_hash{};
  std::string firmware_version;
  std::uint64_t first_utc_ms{};
  std::uint64_t first_sequence{};
  std::uint32_t expected_interval_ms{};
  std::vector<Sample> samples;

  bool operator==(const Archive&) const = default;
};

std::uint32_t crc32(const std::vector<std::uint8_t>& bytes);
std::vector<std::uint8_t> encode(const Archive& archive);
Archive decode(const std::vector<std::uint8_t>& bytes);

}  // namespace gwr1
