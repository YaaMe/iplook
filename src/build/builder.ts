/**
 * Accumulate blocks, then build a table.
 *
 * Two tiers. The friendly one takes strings and is for the caller with a few
 * thousand allowlist entries. The bulk one takes numbers and interns the value
 * once, and is what the CLI uses — at ten million blocks, a string or an object
 * per block is the thing that decides whether the build finishes.
 */

import { NO_VALUE } from "../format.js";
import {
  FAMILY_V4,
  FAMILY_V6,
  indexOfSlash,
  parseAddr,
  parsePrefixLen,
} from "../parse.js";
import { Dict } from "./dict.js";
import { serialize } from "./serialize.js";
import { type ConflictPolicy, rangeToBlocks, sweepV4 } from "./sweep.js";
import { sweepV6 } from "./sweep6.js";

export interface BuildStats {
  /** Blocks accepted. */
  blocks: number;
  /** Spans in the built partition. */
  spans: number;
  /** Distinct values, including the reserved empty one. */
  values: number;
  bytes: number;
}

export interface BuilderOptions {
  onConflict?: ConflictPolicy;
  meta?: Record<string, unknown>;
}

export class InputError extends Error {
  override name = "InputError";
}

export class TableBuilder {
  private readonly dict = new Dict();
  private starts: Uint32Array = new Uint32Array(1024);
  private lens: Uint8Array = new Uint8Array(1024);
  private ids: Uint32Array = new Uint32Array(1024);
  private n = 0;
  private starts6: Uint32Array = new Uint32Array(4 * 256);
  private lens6: Uint8Array = new Uint8Array(256);
  private ids6: Uint32Array = new Uint32Array(256);
  private n6 = 0;
  private readonly scratch = new Uint32Array(4);

  constructor(private readonly opts: BuilderOptions = {}) {}

  /** Intern a value once, for callers adding many blocks that share it. */
  valueId(v: string): number {
    return this.dict.intern(v);
  }

  /** Add a CIDR block such as `10.0.0.0/8`. */
  addPrefix(cidr: string, value: string): void {
    this.addPrefixId(cidr, this.dict.intern(value));
  }

  addPrefixId(raw: string, id: number): void {
    // Trim first.
    //
    // A CIDR read from a file on a machine that writes CRLF arrives as
    // "1.0.0.0/24\r", and the carriage return lands inside the prefix length.
    // The error that produced — `bad prefix length: 1.0.0.0/24` — pointed at
    // the one part of the input that was fine, and sent the reader looking at
    // their prefix lengths. fromText and the CLI already trimmed; this is the
    // path a caller takes when they have their own reader.
    const cidr = raw.trim();
    const slash = indexOfSlash(cidr, 0, cidr.length);
    const addr = slash < 0 ? cidr : cidr.slice(0, slash);
    const fam = parseAddr(addr, this.scratch);

    if (fam === FAMILY_V4) {
      const len = slash < 0 ? 32 : parsePrefixLen(cidr, slash + 1, cidr.length, 32);
      if (len < 0) throw new InputError(badLen(cidr, slash, 32));
      // Masking rather than rejecting: real lists contain 10.0.0.1/8, and the
      // block it means is unambiguous.
      const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
      this.addBlock((this.scratch[0]! & mask) >>> 0, len, id);
      return;
    }
    if (fam === FAMILY_V6) {
      const len = slash < 0 ? 128 : parsePrefixLen(cidr, slash + 1, cidr.length, 128);
      if (len < 0) throw new InputError(badLen(cidr, slash, 128));
      maskInPlace6(this.scratch, len);
      this.addBlock6(this.scratch, len, id);
      return;
    }
    throw new InputError(`not an IP prefix: ${cidr}`);
  }

  /** Bulk: add one aligned IPv6 block. `words` is read, not retained. */
  addBlock6(words: Uint32Array, len: number, id: number): void {
    if (id === NO_VALUE) return;
    if (this.n6 === this.lens6.length) this.grow6();
    for (let k = 0; k < 4; k++) this.starts6[this.n6 * 4 + k] = words[k]!;
    this.lens6[this.n6] = len;
    this.ids6[this.n6] = id;
    this.n6++;
  }

  private grow6(): void {
    const cap = this.lens6.length * 2;
    const s = new Uint32Array(cap * 4);
    s.set(this.starts6);
    this.starts6 = s;
    const l = new Uint8Array(cap);
    l.set(this.lens6);
    this.lens6 = l;
    const i = new Uint32Array(cap);
    i.set(this.ids6);
    this.ids6 = i;
  }

  /** Add every address from `lo` to `hi` inclusive, as dotted quads. */
  addRange(rawLo: string, rawHi: string, value: string): void {
    const lo = rawLo.trim();
    const hi = rawHi.trim();
    const id = this.dict.intern(value);
    const a = parseAddr(lo, this.scratch);
    if (a !== FAMILY_V4) throw new InputError(`not an IPv4 address: ${lo}`);
    const start = this.scratch[0]!;
    const b = parseAddr(hi, this.scratch);
    if (b !== FAMILY_V4) throw new InputError(`not an IPv4 address: ${hi}`);
    const end = this.scratch[0]!;
    if (start > end) throw new InputError(`range starts above its end: ${lo}-${hi}`);
    this.addRangeId(start, end, id);
  }

  /** Bulk: add an inclusive range of pre-parsed addresses under an interned id. */
  addRangeId(lo: number, hi: number, id: number): void {
    rangeToBlocks(lo, hi, (start, len) => this.addBlock(start, len, id));
  }

  /** Bulk: add one aligned block under an interned id. */
  addBlock(start: number, len: number, id: number): void {
    if (id === NO_VALUE) return; // nothing to record; absence is the default
    if (this.n === this.starts.length) this.grow();
    this.starts[this.n] = start >>> 0;
    this.lens[this.n] = len;
    this.ids[this.n] = id;
    this.n++;
  }

  private grow(): void {
    const cap = this.starts.length * 2;
    const s = new Uint32Array(cap);
    s.set(this.starts);
    this.starts = s;
    const l = new Uint8Array(cap);
    l.set(this.lens);
    this.lens = l;
    const i = new Uint32Array(cap);
    i.set(this.ids);
    this.ids = i;
  }

  build(): { buffer: ArrayBuffer; stats: BuildStats } {
    const { values, remap } = this.dict.finalise();

    // Ids were provisional while accumulating so that interning could stay a
    // single map lookup; renumber now that the sorted order is known.
    const ids = new Uint32Array(this.n);
    for (let i = 0; i < this.n; i++) ids[i] = remap[this.ids[i]!]!;
    const ids6 = new Uint32Array(this.n6);
    for (let i = 0; i < this.n6; i++) ids6[i] = remap[this.ids6[i]!]!;

    const partition = sweepV4(
      {
        starts: this.starts.subarray(0, this.n),
        lens: this.lens.subarray(0, this.n),
        ids,
        n: this.n,
      },
      this.opts.onConflict ?? "longest",
    );

    const p6 =
      this.n6 > 0
        ? sweepV6(
            {
              starts: this.starts6.subarray(0, this.n6 * 4),
              lens: this.lens6.subarray(0, this.n6),
              ids: ids6,
              n: this.n6,
            },
            this.opts.onConflict ?? "longest",
          )
        : null;

    const buffer = serialize({
      v4Starts: this.n > 0 ? partition.starts : new Uint32Array(0),
      v4Values: this.n > 0 ? partition.values : new Uint32Array(0),
      v6Starts: p6 ? p6.starts : new Uint32Array(0),
      v6Values: p6 ? p6.values : new Uint32Array(0),
      v6Stride: p6 ? p6.stride : 0,
      values,
      meta: this.opts.meta,
    });

    return {
      buffer,
      stats: {
        blocks: this.n + this.n6,
        spans: (this.n > 0 ? partition.starts.length : 0) + (p6 ? p6.values.length : 0),
        values: values.length,
        bytes: buffer.byteLength,
      },
    };
  }
}

/** Zero the bits below `len` in a four-word address, in place. */
function maskInPlace6(words: Uint32Array, len: number): void {
  for (let k = 0; k < 4; k++) {
    const high = k * 32;
    if (len >= high + 32) continue;
    if (len <= high) {
      words[k] = 0;
      continue;
    }
    words[k] = (words[k]! & (0xffffffff << (32 - (len - high)))) >>> 0;
  }
}

/**
 * Say what is actually wrong with the length.
 *
 * `bad prefix length: 1.0.0.0/24` is what this used to produce for a line
 * ending in a carriage return, and it points at the only part of the input
 * that was correct. Quoting the suffix is what makes an invisible character
 * visible.
 */
function badLen(cidr: string, slash: number, max: number): string {
  const suffix = cidr.slice(slash + 1);
  return `bad prefix length ${JSON.stringify(suffix)} in ${JSON.stringify(cidr)}: expected 0 to ${max}`;
}
