/**
 * Write a partition out as a `.iplk` buffer.
 *
 * Layout decisions live in format.ts; this module only places the sections and
 * fills the bytes.
 */

import {
  align,
  ENCODING_RAW,
  FLAG_HAS_V4,
  FLAG_HAS_V6,
  FORMAT_VERSION,
  HEADER_LENGTH,
  type Header,
  MIN_READER_VERSION,
  valueWidthFor,
  writeHeader,
} from "../format.js";

export interface SerializeInput {
  /** IPv4 span starts, ascending from 0. */
  v4Starts: Uint32Array;
  v4Values: Uint32Array;
  /** IPv6 span starts, `v6Stride` words each, ascending from `::`. */
  v6Starts: Uint32Array;
  v6Values: Uint32Array;
  v6Stride: number;
  /** Value strings; index 0 must be the empty string. */
  values: readonly string[];
  meta?: Record<string, unknown> | undefined;
}

export function serialize(input: SerializeInput): ArrayBuffer {
  const { v4Starts, v4Values, v6Starts, v6Values, v6Stride, values } = input;

  const hasV4 = v4Starts.length > 0;
  const hasV6 = v6Values.length > 0;
  const v4Count = v4Values.length;
  const v6Count = v6Values.length;
  const valueWidth = valueWidthFor(values.length);

  const enc = new TextEncoder();
  const dictBytesParts = values.map((v) => enc.encode(v));
  const dictBytesLength = dictBytesParts.reduce((a, b) => a + b.length, 0);

  const metaBytes =
    input.meta === undefined ? new Uint8Array(0) : enc.encode(JSON.stringify(input.meta));

  // Place the sections. Every offset is absolute and 8-aligned, so a typed
  // array view over any of them is legal regardless of what precedes it.
  let off = align(HEADER_LENGTH);
  const v4StartsOffset = hasV4 ? off : 0;
  if (hasV4) off = align(off + v4Count * 4);
  const v4ValuesOffset = hasV4 ? off : 0;
  if (hasV4) off = align(off + v4Count * valueWidth);

  const v6StartsOffset = hasV6 ? off : 0;
  if (hasV6) off = align(off + v6Count * v6Stride * 4);
  const v6ValuesOffset = hasV6 ? off : 0;
  if (hasV6) off = align(off + v6Count * valueWidth);

  const dictIndexOffset = off;
  off = align(off + (values.length + 1) * 4);
  const dictBytesOffset = off;
  off = align(off + dictBytesLength);
  const metaOffset = metaBytes.length > 0 ? off : 0;
  if (metaBytes.length > 0) off = align(off + metaBytes.length);

  const buf = new ArrayBuffer(off);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  const header: Header = {
    formatVersion: FORMAT_VERSION,
    minReaderVersion: MIN_READER_VERSION,
    flags: (hasV4 ? FLAG_HAS_V4 : 0) | (hasV6 ? FLAG_HAS_V6 : 0),
    v6Stride: hasV6 ? v6Stride : 0,
    valueWidth,
    encoding: ENCODING_RAW,
    headerLength: HEADER_LENGTH,
    v4Count,
    v4StartsOffset,
    v4ValuesOffset,
    v6Count,
    v6StartsOffset,
    v6ValuesOffset,
    dictCount: values.length,
    dictIndexOffset,
    dictBytesOffset,
    dictBytesLength,
    metaOffset,
    metaLength: metaBytes.length,
  };
  writeHeader(view, header);

  if (hasV4) {
    new Uint32Array(buf, v4StartsOffset, v4Count).set(v4Starts);
    writeValues(buf, v4ValuesOffset, v4Values, valueWidth);
  }
  if (hasV6) {
    new Uint32Array(buf, v6StartsOffset, v6Count * v6Stride).set(v6Starts);
    writeValues(buf, v6ValuesOffset, v6Values, valueWidth);
  }

  const dictIndex = new Uint32Array(buf, dictIndexOffset, values.length + 1);
  let cursor = 0;
  for (let i = 0; i < dictBytesParts.length; i++) {
    dictIndex[i] = cursor;
    bytes.set(dictBytesParts[i]!, dictBytesOffset + cursor);
    cursor += dictBytesParts[i]!.length;
  }
  dictIndex[values.length] = cursor;

  if (metaBytes.length > 0) bytes.set(metaBytes, metaOffset);

  return buf;
}

function writeValues(
  buf: ArrayBuffer,
  offset: number,
  values: Uint32Array,
  width: number,
): void {
  if (width === 1) new Uint8Array(buf, offset, values.length).set(values);
  else if (width === 2) new Uint16Array(buf, offset, values.length).set(values);
  else new Uint32Array(buf, offset, values.length).set(values);
}
