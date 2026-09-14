/**
 * The `.iplk` container: header constants, reading and writing.
 *
 * This module is the single source of truth for the byte layout. Nothing else
 * may hard-code an offset — FORMAT.md is prose describing what lives here, and
 * a future reader in another language is expected to be written against it.
 */

/** "IPLK", little-endian. */
export const MAGIC = 0x4b4c5049;

/** What this build writes. */
export const FORMAT_VERSION = 1;

/**
 * The oldest reader that can still make sense of what we write.
 *
 * A later writer that only *adds* sections keeps this at 1: every section is
 * found by an absolute offset, so an older reader skips what it does not know
 * about and stays correct. A writer that changes the meaning of an existing
 * section must raise it, and older readers will refuse the file with a clear
 * message rather than answer wrongly.
 */
export const MIN_READER_VERSION = 1;

/** What this build can read. */
export const READER_VERSION = 1;

export const HEADER_LENGTH = 64;

/** Sections start on an 8-byte boundary, leaving room for wider element types. */
export const SECTION_ALIGN = 8;

export const FLAG_HAS_V4 = 1 << 0;
export const FLAG_HAS_V6 = 1 << 1;

/** Raw little-endian u32 boundaries. Reserved: 1 = delta-varint, if measured to be worth it. */
export const ENCODING_RAW = 0;

/**
 * Value id 0 is reserved and always decodes to the empty string.
 *
 * It is what makes a sparse input use the same code path as a dense one: a gap
 * is not a special case in the reader, it is a span whose value is "none".
 */
export const NO_VALUE = 0;

export interface Header {
  formatVersion: number;
  minReaderVersion: number;
  flags: number;
  /** u32 words per boundary, 1..4. IPv4 is always 1; IPv6 is 1..4 by what the data needs. */
  v6Stride: number;
  /** Bytes per value id: 1, 2 or 4. */
  valueWidth: number;
  encoding: number;
  headerLength: number;
  v4Count: number;
  v4StartsOffset: number;
  v4ValuesOffset: number;
  v6Count: number;
  v6StartsOffset: number;
  v6ValuesOffset: number;
  dictCount: number;
  dictIndexOffset: number;
  dictBytesOffset: number;
  dictBytesLength: number;
  metaOffset: number;
  metaLength: number;
}

// Byte offsets within the header. Every u32 field is 4-aligned so a DataView
// read is never unaligned on platforms that care.
const O_MAGIC = 0;
const O_FORMAT_VERSION = 4;
const O_MIN_READER_VERSION = 5;
const O_FLAGS = 6;
const O_V6_STRIDE = 7;
const O_VALUE_WIDTH = 8;
const O_ENCODING = 9;
// 10..11 reserved
const O_HEADER_LENGTH = 12;
const O_V4_COUNT = 16;
const O_V4_STARTS = 20;
const O_V4_VALUES = 24;
const O_V6_COUNT = 28;
const O_V6_STARTS = 32;
const O_V6_VALUES = 36;
const O_DICT_COUNT = 40;
const O_DICT_INDEX = 44;
const O_DICT_BYTES = 48;
const O_DICT_BYTES_LEN = 52;
const O_META = 56;
const O_META_LEN = 60;

export class FormatError extends Error {
  override name = "FormatError";
}

/** Round `n` up to the next section boundary. */
export function align(n: number): number {
  return (n + (SECTION_ALIGN - 1)) & ~(SECTION_ALIGN - 1);
}

/** The narrowest value width that can hold `dictCount` ids. */
export function valueWidthFor(dictCount: number): 1 | 2 | 4 {
  if (dictCount <= 0x100) return 1;
  if (dictCount <= 0x10000) return 2;
  return 4;
}

export function writeHeader(view: DataView, h: Header): void {
  view.setUint32(O_MAGIC, MAGIC, true);
  view.setUint8(O_FORMAT_VERSION, h.formatVersion);
  view.setUint8(O_MIN_READER_VERSION, h.minReaderVersion);
  view.setUint8(O_FLAGS, h.flags);
  view.setUint8(O_V6_STRIDE, h.v6Stride);
  view.setUint8(O_VALUE_WIDTH, h.valueWidth);
  view.setUint8(O_ENCODING, h.encoding);
  view.setUint32(O_HEADER_LENGTH, h.headerLength, true);
  view.setUint32(O_V4_COUNT, h.v4Count, true);
  view.setUint32(O_V4_STARTS, h.v4StartsOffset, true);
  view.setUint32(O_V4_VALUES, h.v4ValuesOffset, true);
  view.setUint32(O_V6_COUNT, h.v6Count, true);
  view.setUint32(O_V6_STARTS, h.v6StartsOffset, true);
  view.setUint32(O_V6_VALUES, h.v6ValuesOffset, true);
  view.setUint32(O_DICT_COUNT, h.dictCount, true);
  view.setUint32(O_DICT_INDEX, h.dictIndexOffset, true);
  view.setUint32(O_DICT_BYTES, h.dictBytesOffset, true);
  view.setUint32(O_DICT_BYTES_LEN, h.dictBytesLength, true);
  view.setUint32(O_META, h.metaOffset, true);
  view.setUint32(O_META_LEN, h.metaLength, true);
}

export function readHeader(view: DataView): Header {
  if (view.byteLength < HEADER_LENGTH) {
    throw new FormatError(
      `not an iplook table: ${view.byteLength} bytes is shorter than the ${HEADER_LENGTH}-byte header`,
    );
  }
  if (view.getUint32(O_MAGIC, true) !== MAGIC) {
    throw new FormatError("not an iplook table: bad magic");
  }

  const minReader = view.getUint8(O_MIN_READER_VERSION);
  if (minReader > READER_VERSION) {
    throw new FormatError(
      `table needs a reader of version ${minReader}, this is version ${READER_VERSION}`,
    );
  }

  const h: Header = {
    formatVersion: view.getUint8(O_FORMAT_VERSION),
    minReaderVersion: minReader,
    flags: view.getUint8(O_FLAGS),
    v6Stride: view.getUint8(O_V6_STRIDE),
    valueWidth: view.getUint8(O_VALUE_WIDTH),
    encoding: view.getUint8(O_ENCODING),
    headerLength: view.getUint32(O_HEADER_LENGTH, true),
    v4Count: view.getUint32(O_V4_COUNT, true),
    v4StartsOffset: view.getUint32(O_V4_STARTS, true),
    v4ValuesOffset: view.getUint32(O_V4_VALUES, true),
    v6Count: view.getUint32(O_V6_COUNT, true),
    v6StartsOffset: view.getUint32(O_V6_STARTS, true),
    v6ValuesOffset: view.getUint32(O_V6_VALUES, true),
    dictCount: view.getUint32(O_DICT_COUNT, true),
    dictIndexOffset: view.getUint32(O_DICT_INDEX, true),
    dictBytesOffset: view.getUint32(O_DICT_BYTES, true),
    dictBytesLength: view.getUint32(O_DICT_BYTES_LEN, true),
    metaOffset: view.getUint32(O_META, true),
    metaLength: view.getUint32(O_META_LEN, true),
  };

  if (h.encoding !== ENCODING_RAW) {
    throw new FormatError(`unsupported boundary encoding ${h.encoding}`);
  }
  if (h.valueWidth !== 1 && h.valueWidth !== 2 && h.valueWidth !== 4) {
    throw new FormatError(`bad value width ${h.valueWidth}, expected 1, 2 or 4`);
  }
  if ((h.flags & FLAG_HAS_V6) !== 0 && (h.v6Stride < 1 || h.v6Stride > 4)) {
    throw new FormatError(`bad IPv6 stride ${h.v6Stride}, expected 1..4`);
  }
  return h;
}
