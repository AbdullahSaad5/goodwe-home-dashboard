#pragma once

#include <cstdint>
#include <vector>

namespace goodwe_protocol {

enum class ReadRange : std::uint8_t { device_info, runtime, battery, meter };

struct RangeDefinition {
  std::uint16_t first_register;
  std::uint16_t register_count;
};

RangeDefinition definition(ReadRange range);
std::vector<std::uint8_t> make_read_request(std::uint16_t transaction, ReadRange range);
bool validate_read_response(const std::vector<std::uint8_t>& frame,
                            std::uint16_t transaction,
                            ReadRange range);

}  // namespace goodwe_protocol
