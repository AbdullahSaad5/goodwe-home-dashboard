#include "gwr1.hpp"

#include <algorithm>
#include <array>
#include <limits>
#include <stdexcept>
#include <string_view>

namespace gwr1 {
namespace {

constexpr std::array<std::uint8_t, 4> magic{0x47, 0x57, 0x52, 0x31};
constexpr std::uint8_t format_version = 1;
constexpr std::uint16_t header_length = 98;
constexpr std::size_t firmware_length = 16;
constexpr std::size_t trailer_length = 8;

class Writer {
 public:
  void bytes(const std::uint8_t* begin, const std::size_t length) {
    output_.insert(output_.end(), begin, begin + length);
  }

  template <std::size_t Size>
  void bytes(const std::array<std::uint8_t, Size>& value) {
    bytes(value.data(), value.size());
  }

  void bytes(const std::vector<std::uint8_t>& value) { bytes(value.data(), value.size()); }

  void u8(const std::uint8_t value) { output_.push_back(value); }

  void u16(const std::uint16_t value) {
    u8(static_cast<std::uint8_t>(value >> 8U));
    u8(static_cast<std::uint8_t>(value));
  }

  void u32(const std::uint32_t value) {
    for (int shift = 24; shift >= 0; shift -= 8) {
      u8(static_cast<std::uint8_t>(value >> shift));
    }
  }

  void u64(const std::uint64_t value) {
    for (int shift = 56; shift >= 0; shift -= 8) {
      u8(static_cast<std::uint8_t>(value >> shift));
    }
  }

  void varuint(std::uint64_t value) {
    do {
      auto next = static_cast<std::uint8_t>(value & 0x7fU);
      value >>= 7U;
      if (value != 0) next |= 0x80U;
      u8(next);
    } while (value != 0);
  }

  const std::vector<std::uint8_t>& output() const { return output_; }
  std::vector<std::uint8_t> take() { return std::move(output_); }

 private:
  std::vector<std::uint8_t> output_;
};

class Reader {
 public:
  explicit Reader(const std::vector<std::uint8_t>& input, const std::size_t limit)
      : input_(input), limit_(limit) {}

  std::vector<std::uint8_t> bytes(const std::size_t length) {
    require(length);
    std::vector<std::uint8_t> result(input_.begin() + static_cast<std::ptrdiff_t>(offset_),
                                     input_.begin() + static_cast<std::ptrdiff_t>(offset_ + length));
    offset_ += length;
    return result;
  }

  std::uint8_t u8() {
    require(1);
    return input_.at(offset_++);
  }

  std::uint16_t u16() {
    return static_cast<std::uint16_t>((static_cast<std::uint16_t>(u8()) << 8U) | u8());
  }

  std::uint32_t u32() {
    std::uint32_t value = 0;
    for (int index = 0; index < 4; ++index) value = (value << 8U) | u8();
    return value;
  }

  std::uint64_t u64() {
    std::uint64_t value = 0;
    for (int index = 0; index < 8; ++index) value = (value << 8U) | u8();
    return value;
  }

  std::uint64_t varuint() {
    std::uint64_t value = 0;
    for (unsigned shift = 0; shift < 64; shift += 7) {
      const auto byte = u8();
      value |= static_cast<std::uint64_t>(byte & 0x7fU) << shift;
      if ((byte & 0x80U) == 0) return value;
    }
    throw std::runtime_error("Invalid GWR1 varuint");
  }

  std::size_t remaining() const { return limit_ - offset_; }

 private:
  void require(const std::size_t length) const {
    if (length > remaining()) throw std::runtime_error("Truncated GWR1");
  }

  const std::vector<std::uint8_t>& input_;
  std::size_t limit_;
  std::size_t offset_{};
};

template <std::size_t Size>
std::array<std::uint8_t, Size> array_from(const std::vector<std::uint8_t>& value) {
  if (value.size() != Size) throw std::runtime_error("Invalid GWR1 fixed field");
  std::array<std::uint8_t, Size> result{};
  std::copy(value.begin(), value.end(), result.begin());
  return result;
}

}  // namespace

std::uint32_t crc32(const std::vector<std::uint8_t>& bytes) {
  std::uint32_t crc = 0xffffffffU;
  for (const auto byte : bytes) {
    crc ^= byte;
    for (int bit = 0; bit < 8; ++bit) {
      crc = (crc >> 1U) ^ ((crc & 1U) != 0 ? 0xedb88320U : 0U);
    }
  }
  return crc ^ 0xffffffffU;
}

std::vector<std::uint8_t> encode(const Archive& archive) {
  if (archive.firmware_version.size() > firmware_length) {
    throw std::runtime_error("Firmware version exceeds 16 bytes");
  }
  if (archive.samples.size() > std::numeric_limits<std::uint16_t>::max()) {
    throw std::runtime_error("Too many GWR1 samples");
  }

  Writer writer;
  writer.bytes(magic);
  writer.u8(format_version);
  writer.u8(0);
  writer.u16(header_length);
  writer.bytes(archive.device_id);
  writer.u8(archive.inverter_family);
  writer.u8(archive.transport);
  writer.bytes(archive.decoder_hash);
  std::array<std::uint8_t, firmware_length> firmware{};
  std::copy(archive.firmware_version.begin(), archive.firmware_version.end(), firmware.begin());
  writer.bytes(firmware);
  writer.u64(archive.first_utc_ms);
  writer.u64(archive.first_sequence);
  writer.u32(archive.expected_interval_ms);
  writer.u16(static_cast<std::uint16_t>(archive.samples.size()));
  writer.u16(0);

  for (const auto& sample : archive.samples) {
    if (sample.frames.size() > std::numeric_limits<std::uint8_t>::max()) {
      throw std::runtime_error("Too many frames in GWR1 sample");
    }
    writer.varuint(sample.timestamp_delta_ms);
    writer.varuint(sample.sequence_delta);
    writer.u16(sample.status_flags);
    writer.u8(sample.timestamp_source);
    writer.u8(static_cast<std::uint8_t>(sample.frames.size()));
    for (const auto& frame : sample.frames) {
      if (frame.size() > std::numeric_limits<std::uint16_t>::max()) {
        throw std::runtime_error("GWR1 frame is too large");
      }
      writer.u16(static_cast<std::uint16_t>(frame.size()));
      writer.bytes(frame);
    }
  }

  const auto body_length = writer.output().size();
  if (body_length > std::numeric_limits<std::uint32_t>::max()) {
    throw std::runtime_error("GWR1 archive is too large");
  }
  const auto checksum = crc32(writer.output());
  writer.u32(static_cast<std::uint32_t>(body_length));
  writer.u32(checksum);
  return writer.take();
}

Archive decode(const std::vector<std::uint8_t>& bytes) {
  if (bytes.size() < header_length + trailer_length) throw std::runtime_error("Truncated GWR1");
  const auto body_length = bytes.size() - trailer_length;
  Reader trailer(bytes, bytes.size());
  static_cast<void>(trailer.bytes(body_length));
  if (trailer.u32() != body_length) throw std::runtime_error("Invalid GWR1 uncompressed length");
  const auto expected_crc = trailer.u32();
  const std::vector<std::uint8_t> body(bytes.begin(), bytes.begin() + static_cast<std::ptrdiff_t>(body_length));
  if (crc32(body) != expected_crc) throw std::runtime_error("Invalid GWR1 CRC32");

  Reader reader(bytes, body_length);
  if (array_from<4>(reader.bytes(4)) != magic) throw std::runtime_error("Invalid GWR1 magic");
  if (reader.u8() != format_version) throw std::runtime_error("Unsupported GWR1 version");
  static_cast<void>(reader.u8());
  if (reader.u16() != header_length) throw std::runtime_error("Invalid GWR1 header length");

  Archive archive;
  archive.device_id = array_from<16>(reader.bytes(16));
  archive.inverter_family = reader.u8();
  archive.transport = reader.u8();
  archive.decoder_hash = array_from<32>(reader.bytes(32));
  const auto firmware = reader.bytes(firmware_length);
  const auto firmware_end = std::find(firmware.begin(), firmware.end(), 0);
  archive.firmware_version.assign(firmware.begin(), firmware_end);
  archive.first_utc_ms = reader.u64();
  archive.first_sequence = reader.u64();
  archive.expected_interval_ms = reader.u32();
  const auto sample_count = reader.u16();
  static_cast<void>(reader.u16());

  archive.samples.reserve(sample_count);
  for (std::size_t sample_index = 0; sample_index < sample_count; ++sample_index) {
    Sample sample;
    sample.timestamp_delta_ms = reader.varuint();
    sample.sequence_delta = reader.varuint();
    sample.status_flags = reader.u16();
    sample.timestamp_source = reader.u8();
    const auto frame_count = reader.u8();
    sample.frames.reserve(frame_count);
    for (std::size_t frame_index = 0; frame_index < frame_count; ++frame_index) {
      sample.frames.push_back(reader.bytes(reader.u16()));
    }
    archive.samples.push_back(std::move(sample));
  }
  if (reader.remaining() != 0) throw std::runtime_error("Unexpected bytes in GWR1 body");
  return archive;
}

}  // namespace gwr1
