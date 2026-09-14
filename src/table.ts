/**
 * Loading a `.iplk` table and answering questions with it.
 */

import {
  FLAG_HAS_V4,
  FLAG_HAS_V6,
  FormatError,
  type Header,
  NO_VALUE,
  readHeader,
} from "./format.js";
import { FAMILY_V4, FAMILY_V6, parseAddr } from "./parse.js";
import {
  buildIndex1,
  buildIndexN,
  indexBitsFor,
  MAX_INDEX_BITS,
  MIN_INDEX_BITS,
  searchStride1,
  searchStrideN,
} from "./search.js";

export interface LoadOptions {
  /**
   * The coarse index that brackets the search.
   *
   * - `true` (default) — size it to the table: about two spans a bucket,
   *   capped at 18 bits. See {@link indexBitsFor}.
   * - `false` — do not build one. The lookup falls back to a plain binary
   *   search over the whole table, which costs nothing in memory and is
   *   roughly three times slower on a large one.
   * - a number — that many bits of the address, 4 to 24. The index is
   *   `2^bits + 1` uint32s, so 18 is 1 MB and 24 is 64 MB. It is derived
   *   state: whatever you choose, every answer is identical.
   */
  index?: boolean | number;
  /** Check the partition invariants at load. Default true. */
  validate?: boolean;
}

/** Scratch for the parsed address. Reused; parsing and lookup are synchronous. */
const scratch = new Uint32Array(4);

export class IpTable {
  private readonly header: Header;
  private readonly v4Starts: Uint32Array;
  private readonly v4Values: Uint8Array | Uint16Array | Uint32Array;
  private readonly v6Starts: Uint32Array;
  private readonly v6Values: Uint8Array | Uint16Array | Uint32Array;
  private readonly v6Stride: number;
  private readonly v4Index: Uint32Array | null;
  private readonly v6Index: Uint32Array | null;
  private readonly v4Shift: number = 0;
  private readonly v6Shift: number = 0;
  private readonly v4Bits: number = 0;
  private readonly v6Bits: number = 0;

  /** The value strings. Index 0 is the empty string, meaning "no value". */
  readonly values: readonly string[];

  constructor(src: ArrayBuffer | ArrayBufferView, opts: LoadOptions = {}) {
    const { buffer, byteOffset, byteLength } = normalise(src);
    const view = new DataView(buffer, byteOffset, byteLength);
    const h = readHeader(view);
    this.header = h;

    const base = byteOffset;
    const hasV4 = (h.flags & FLAG_HAS_V4) !== 0;
    const hasV6 = (h.flags & FLAG_HAS_V6) !== 0;

    this.v4Starts = hasV4
      ? new Uint32Array(buffer, base + h.v4StartsOffset, h.v4Count)
      : new Uint32Array(0);
    this.v4Values = hasV4
      ? readValues(buffer, base + h.v4ValuesOffset, h.v4Count, h.valueWidth)
      : new Uint8Array(0);

    this.v6Stride = hasV6 ? h.v6Stride : 0;
    this.v6Starts = hasV6
      ? new Uint32Array(buffer, base + h.v6StartsOffset, h.v6Count * h.v6Stride)
      : new Uint32Array(0);
    this.v6Values = hasV6
      ? readValues(buffer, base + h.v6ValuesOffset, h.v6Count, h.valueWidth)
      : new Uint8Array(0);

    this.values = readDict(buffer, base, h);

    if (opts.validate !== false) this.validate();

    const wantIndex = opts.index !== false;
    const explicit = typeof opts.index === "number" ? opts.index : undefined;
    if (explicit !== undefined) {
      if (!Number.isInteger(explicit) || explicit < MIN_INDEX_BITS || explicit > MAX_INDEX_BITS) {
        throw new RangeError(
          `index must be an integer between ${MIN_INDEX_BITS} and ${MAX_INDEX_BITS}, got ${explicit}`,
        );
      }
    }

    const v4Bits = explicit ?? indexBitsFor(h.v4Count);
    const v6Bits = explicit ?? indexBitsFor(h.v6Count);
    this.v4Bits = v4Bits;
    this.v6Bits = v6Bits;
    this.v4Shift = 32 - v4Bits;
    this.v6Shift = 32 - v6Bits;
    this.v4Index = wantIndex && h.v4Count > 0 ? buildIndex1(this.v4Starts, v4Bits) : null;
    this.v6Index =
      wantIndex && h.v6Count > 0
        ? buildIndexN(this.v6Starts, this.v6Stride, h.v6Count, v6Bits)
        : null;
  }

  /**
   * The invariants the format rests on.
   *
   * These are properties of a *built* table, not of anyone's input, and every
   * read depends on them totally. A file that violates one answers wrongly and
   * never says so, which is the worst thing a bundled asset can do — so it is
   * checked once at load rather than assumed. About a millisecond for 312k
   * spans.
   */
  private validate(): void {
    if (this.header.v4Count > 0) {
      if (this.v4Starts[0] !== 0) {
        throw new FormatError("IPv4 partition does not start at 0.0.0.0");
      }
      for (let i = 1; i < this.v4Starts.length; i++) {
        if (this.v4Starts[i]! <= this.v4Starts[i - 1]!) {
          throw new FormatError(`IPv4 span starts are not increasing at index ${i}`);
        }
      }
    }
    if (this.header.v6Count > 0) {
      const s = this.v6Starts;
      const st = this.v6Stride;
      for (let k = 0; k < st; k++) {
        if (s[k] !== 0) throw new FormatError("IPv6 partition does not start at ::");
      }
      for (let i = 1; i < this.header.v6Count; i++) {
        let cmp = 0;
        for (let k = 0; k < st && cmp === 0; k++) {
          const a = s[(i - 1) * st + k]!;
          const b = s[i * st + k]!;
          cmp = a === b ? 0 : a < b ? -1 : 1;
        }
        if (cmp >= 0) {
          throw new FormatError(`IPv6 span starts are not increasing at index ${i}`);
        }
      }
    }
  }

  /** The value for `ip`, or undefined if it has none or is not an address. */
  lookup(ip: string): string | undefined {
    const id = this.lookupId(ip);
    return id === NO_VALUE ? undefined : this.values[id];
  }

  /** The value id for `ip`. 0 means no value, and also means unparseable. */
  lookupId(ip: string): number {
    const fam = parseAddr(ip, scratch);
    if (fam === FAMILY_V4) return this.lookupV4(scratch[0]!);
    if (fam === FAMILY_V6) return this.lookupV6(scratch);
    return NO_VALUE;
  }

  /** The value id for a pre-parsed IPv4 address. */
  lookupV4(v: number): number {
    if (this.header.v4Count === 0) return NO_VALUE;
    const i = this.v4Index
      ? searchStride1(this.v4Starts, this.v4Index, this.v4Shift, v >>> 0)
      : linear1(this.v4Starts, v >>> 0);
    return this.v4Values[i]!;
  }

  private lookupV6(a: Uint32Array): number {
    if (this.header.v6Count === 0 || !this.v6Index) return NO_VALUE;
    const i = searchStrideN(
      this.v6Starts,
      this.v6Index,
      this.header.v6Count,
      this.v6Stride,
      this.v6Shift,
      a,
    );
    return this.v6Values[i]!;
  }

  /**
   * What the table holds and what the index costs.
   *
   * `indexBytes` is heap, not bundle: the index is derived at load and is not
   * in the file. `indexBits` is what was chosen, so a caller tuning it can see
   * where it landed.
   */
  get size(): {
    v4: number;
    v6: number;
    bytes: number;
    indexBits: { v4: number; v6: number };
    indexBytes: number;
  } {
    return {
      indexBits: { v4: this.v4Bits, v6: this.v6Bits },
      indexBytes:
        (this.v4Index?.byteLength ?? 0) + (this.v6Index?.byteLength ?? 0),
      v4: this.header.v4Count,
      v6: this.header.v6Count,
      bytes:
        this.v4Starts.byteLength +
        this.v4Values.byteLength +
        this.v6Starts.byteLength +
        this.v6Values.byteLength,
    };
  }
}

function linear1(starts: Uint32Array, v: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (starts[mid]! <= v) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Produce a buffer whose sections can be viewed as typed arrays.
 *
 * `new Uint32Array(buf, off, n)` throws unless the absolute offset is a
 * multiple of 4, and in Node a `Buffer` is a view into a shared 8 KB pool at an
 * arbitrary offset — so this fires in practice, not in theory. When the base is
 * not 8-aligned the buffer is copied once, which is the only way to make every
 * section's alignment a property of the format rather than of the caller.
 */
function normalise(src: ArrayBuffer | ArrayBufferView): {
  buffer: ArrayBuffer;
  byteOffset: number;
  byteLength: number;
} {
  if (src instanceof ArrayBuffer) {
    return { buffer: src, byteOffset: 0, byteLength: src.byteLength };
  }
  if (src.byteOffset % 8 === 0) {
    return {
      buffer: src.buffer as ArrayBuffer,
      byteOffset: src.byteOffset,
      byteLength: src.byteLength,
    };
  }
  const copy = new Uint8Array(src.byteLength);
  copy.set(new Uint8Array(src.buffer as ArrayBuffer, src.byteOffset, src.byteLength));
  return { buffer: copy.buffer, byteOffset: 0, byteLength: copy.byteLength };
}

function readValues(
  buffer: ArrayBuffer,
  offset: number,
  count: number,
  width: number,
): Uint8Array | Uint16Array | Uint32Array {
  if (width === 1) return new Uint8Array(buffer, offset, count);
  if (width === 2) return new Uint16Array(buffer, offset, count);
  return new Uint32Array(buffer, offset, count);
}

function readDict(buffer: ArrayBuffer, base: number, h: Header): readonly string[] {
  const index = new Uint32Array(buffer, base + h.dictIndexOffset, h.dictCount + 1);
  const blob = new Uint8Array(buffer, base + h.dictBytesOffset, h.dictBytesLength);
  const dec = new TextDecoder();
  const out: string[] = [];
  for (let i = 0; i < h.dictCount; i++) {
    out.push(dec.decode(blob.subarray(index[i]!, index[i + 1]!)));
  }
  return Object.freeze(out);
}
