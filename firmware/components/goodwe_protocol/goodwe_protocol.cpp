#include "goodwe_protocol.hpp"

#include <array>
#include <stdexcept>

namespace goodwe_protocol {
namespace {

constexpr std::uint8_t unit_address = 0xf7;
constexpr std::uint8_t read_function = 0x03;

std::uint16_t read_u16(const std::vector<std::uint8_t>& bytes, const std::size_t offset) {
  return static_cast<std::uint16_t>((static_cast<std::uint16_t>(bytes.at(offset)) << 8U) |
                                    bytes.at(offset + 1));
}

}  // namespace

RangeDefinition definition(const ReadRange range) {
  switch (range) {
    case ReadRange::device_info:
      return {0x88b8, 0x0021};
    case ReadRange::runtime:
      return {0x891c, 0x007d};
    case ReadRange::battery:
      return {0x9088, 0x0018};
    case ReadRange::meter:
      return {0x8ca0, 0x002d};
  }
  throw std::invalid_argument("Unknown GoodWe read range");
}

std::vector<std::uint8_t> make_read_request(const std::uint16_t transaction,
                                            const ReadRange range) {
  const auto selected = definition(range);
  return {
      static_cast<std::uint8_t>(transaction >> 8U),
      static_cast<std::uint8_t>(transaction),
      0,
      0,
      0,
      6,
      unit_address,
      read_function,
      static_cast<std::uint8_t>(selected.first_register >> 8U),
      static_cast<std::uint8_t>(selected.first_register),
      static_cast<std::uint8_t>(selected.register_count >> 8U),
      static_cast<std::uint8_t>(selected.register_count),
  };
}

bool validate_read_response(const std::vector<std::uint8_t>& frame,
                            const std::uint16_t transaction,
                            const ReadRange range) {
  const auto selected = definition(range);
  const auto byte_count = static_cast<std::size_t>(selected.register_count) * 2;
  const auto message_length = byte_count + 3;
  if (frame.size() != byte_count + 9 || message_length > 0xffff) return false;
  if (read_u16(frame, 0) != transaction || read_u16(frame, 2) != 0 ||
      read_u16(frame, 4) != message_length) {
    return false;
  }
  return frame[6] == unit_address && frame[7] == read_function && frame[8] == byte_count;
}

}  // namespace goodwe_protocol
