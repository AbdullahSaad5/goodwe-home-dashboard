#include "goodwe_protocol.hpp"

#include <cassert>
#include <cstdint>
#include <vector>

namespace {

std::vector<std::uint8_t> response(const std::uint16_t transaction, const std::uint16_t registers) {
  const auto byte_count = static_cast<std::uint8_t>(registers * 2);
  const auto length = static_cast<std::uint16_t>(byte_count + 3);
  std::vector<std::uint8_t> frame{
      static_cast<std::uint8_t>(transaction >> 8U), static_cast<std::uint8_t>(transaction),
      0, 0, static_cast<std::uint8_t>(length >> 8U), static_cast<std::uint8_t>(length),
      0xf7, 0x03, byte_count,
  };
  frame.resize(static_cast<std::size_t>(9 + byte_count));
  return frame;
}

}  // namespace

int main() {
  using goodwe_protocol::ReadRange;

  assert(goodwe_protocol::make_read_request(1, ReadRange::runtime) ==
         std::vector<std::uint8_t>({0, 1, 0, 0, 0, 6, 0xf7, 3, 0x89, 0x1c, 0, 0x7d}));
  assert(goodwe_protocol::make_read_request(2, ReadRange::battery) ==
         std::vector<std::uint8_t>({0, 2, 0, 0, 0, 6, 0xf7, 3, 0x90, 0x88, 0, 0x18}));

  const auto runtime = response(7, 125);
  assert(runtime.size() == 259);
  assert(goodwe_protocol::validate_read_response(runtime, 7, ReadRange::runtime));

  auto wrong_transaction = runtime;
  wrong_transaction[1] = 8;
  assert(!goodwe_protocol::validate_read_response(wrong_transaction, 7, ReadRange::runtime));

  auto write_response = runtime;
  write_response[7] = 0x06;
  assert(!goodwe_protocol::validate_read_response(write_response, 7, ReadRange::runtime));

  auto truncated = runtime;
  truncated.pop_back();
  assert(!goodwe_protocol::validate_read_response(truncated, 7, ReadRange::runtime));
}
