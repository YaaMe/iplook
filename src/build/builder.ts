/**
 * Accumulate blocks, then build a table.
 *
 * Two tiers. The friendly one takes strings and is for the caller with a few
 * thousand allowlist entries. The bulk one takes numbers and interns the value
 * once, and is what the CLI uses — at ten million blocks, a string or an object
 * per block is the thing that decides whether the build finishes.
 */

import { NO_VALUE } from "../format.js";
import { FAMILY_V4, indexOfSlash, parseAddr, parsePrefixLen } from "../parse.js";
import { Dict } from "./dict.js";
import { serialize } from "./serialize.js";
import { type ConflictPolicy, rangeToBlocks, sweepV4 } from "./sweep.js";

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

  addPrefixId(cidr: string, id: number): void {
    const slash = indexOfSlash(cidr, 0, cidr.length);
    if (slash < 0) {
      // A bare address is a host route.
      const fam = parseAddr(cidr, this.scratch);
      if (fam !== FAMILY_V4) throw new InputError(`not an IPv4 address: ${cidr}`);
      this.addBlock(this.scratch[0]!, 32, id);
      return;
    }
    const addr = cidr.slice(0, slash);
    const fam = parseAddr(addr, this.scratch);
    if (fam !== FAMILY_V4) throw new InputError(`not an IPv4 prefix: ${cidr}`);
    const len = parsePrefixLen(cidr, slash + 1, cidr.length, 32);
    if (len < 0) throw new InputError(`bad prefix length: ${cidr}`);

    // Masking rather than rejecting: real lists contain 10.0.0.1/8, and the
    // block it means is unambiguous.
    const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
    this.addBlock((this.scratch[0]! & mask) >>> 0, len, id);
  }

  /** Add every address from `lo` to `hi` inclusive, as dotted quads. */
  addRange(lo: string, hi: string, value: string): void {
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

    const partition = sweepV4(
      {
        starts: this.starts.subarray(0, this.n),
        lens: this.lens.subarray(0, this.n),
        ids,
        n: this.n,
      },
      this.opts.onConflict ?? "longest",
    );

    const buffer = serialize({
      v4Starts: partition.starts,
      v4Values: partition.values,
      v6Starts: new Uint32Array(0),
      v6Values: new Uint32Array(0),
      v6Stride: 0,
      values,
      meta: this.opts.meta,
    });

    return {
      buffer,
      stats: {
        blocks: this.n,
        spans: partition.starts.length,
        values: values.length,
        bytes: buffer.byteLength,
      },
    };
  }
}
