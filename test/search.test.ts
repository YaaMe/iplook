import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildIndex1,
  buildIndexN,
  indexBitsFor,
  MAX_INDEX_BITS,
  MIN_INDEX_BITS,
  searchStride1,
  searchStrideN,
} from "../src/search.js";

/** The definition the index is an optimisation of: the last start at or below v. */
function naive(starts: Uint32Array, v: number): number {
  let best = 0;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i]! <= v) best = i;
    else break;
  }
  return best;
}

describe("indexBitsFor", () => {
  it("stays inside the range the loader will accept", () => {
    for (const n of [0, 1, 2, 10, 1e3, 1e5, 1e6, 1e9]) {
      const b = indexBitsFor(n);
      expect(b).toBeGreaterThanOrEqual(MIN_INDEX_BITS);
      expect(b).toBeLessThanOrEqual(MAX_INDEX_BITS);
      expect(Number.isInteger(b)).toBe(true);
    }
  });

  it("never shrinks as the table grows", () => {
    let prev = 0;
    for (let n = 1; n < 2_000_000; n = Math.ceil(n * 1.7)) {
      const b = indexBitsFor(n);
      expect(b).toBeGreaterThanOrEqual(prev);
      prev = b;
    }
  });

  it("holds a floor for tiny tables and a ceiling for huge ones", () => {
    // A hundred-span allowlist should not carry a megabyte of index; a
    // ten-million-span table should not carry sixty-four.
    expect(indexBitsFor(1)).toBe(8);
    expect(indexBitsFor(100)).toBe(8);
    expect(indexBitsFor(10_000_000)).toBe(18);
  });

  // floor(log2(spans)) buckets puts occupancy in [1, 2) between the floor and
  // the ceiling — exactly 1 at a power of two, approaching 2 just below the
  // next one.
  it("keeps occupancy between one and two spans a bucket in between", () => {
    for (const n of [4096, 6000, 65_536, 100_000, 262_144]) {
      const perBucket = n / 2 ** indexBitsFor(n);
      expect(perBucket).toBeGreaterThanOrEqual(1);
      expect(perBucket).toBeLessThan(2);
    }
  });
});

describe("the stride-1 index brackets the answer", () => {
  const arbStarts = fc
    .uniqueArray(fc.integer({ min: 1, max: 0xffffffff }), {
      minLength: 1,
      maxLength: 200,
    })
    .map((xs) => Uint32Array.from([0, ...xs].sort((a, b) => a - b)));

  it("agrees with the definition at every width", () => {
    fc.assert(
      fc.property(arbStarts, fc.integer({ min: 4, max: 20 }), (starts, bits) => {
        const idx = buildIndex1(starts, bits);
        const shift = 32 - bits;
        // Boundaries and their neighbours, where every off-by-one lives.
        for (const s of starts) {
          for (const v of [s - 1, s, s + 1, 0, 0xffffffff]) {
            if (v < 0 || v > 0xffffffff) continue;
            const got = searchStride1(starts, idx, shift, v >>> 0);
            if (got !== naive(starts, v >>> 0)) return false;
          }
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it("keeps the bracket valid: lo <= answer <= hi", () => {
    fc.assert(
      fc.property(arbStarts, fc.integer({ min: 4, max: 16 }), (starts, bits) => {
        const idx = buildIndex1(starts, bits);
        const shift = 32 - bits;
        for (let i = 0; i < 200; i++) {
          const v = (i * 2654435761) >>> 0;
          const answer = naive(starts, v);
          const lo = idx[v >>> shift]!;
          const hi = idx[(v >>> shift) + 1]!;
          if (answer < lo || answer > hi) return false;
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it("handles a single span covering everything", () => {
    const starts = Uint32Array.of(0);
    const idx = buildIndex1(starts, 8);
    for (const v of [0, 1, 0x7fffffff, 0x80000000, 0xffffffff]) {
      expect(searchStride1(starts, idx, 24, v >>> 0)).toBe(0);
    }
  });
});

describe("the strided index", () => {
  /** Boundaries as interleaved words, ascending. */
  function build(stride: number, rows: number[][]): Uint32Array {
    const out = new Uint32Array(rows.length * stride);
    rows.forEach((r, i) => {
      for (let k = 0; k < stride; k++) out[i * stride + k] = r[k] ?? 0;
    });
    return out;
  }

  it("compares whole boundaries, not just the first word", () => {
    // Three boundaries sharing a first word: only the lower words tell them
    // apart, so a first-word-only comparison would answer wrongly here.
    const stride = 2;
    const starts = build(stride, [
      [0, 0],
      [0x20010db8, 0x00000000],
      [0x20010db8, 0x80000000],
    ]);
    const idx = buildIndexN(starts, stride, 3, 8);
    const a = new Uint32Array(4);

    const at = (hi: number, lo: number) => {
      a[0] = hi;
      a[1] = lo;
      return searchStrideN(starts, idx, 3, stride, 24, a);
    };
    expect(at(0, 0)).toBe(0);
    expect(at(0x20010db7, 0xffffffff)).toBe(0);
    expect(at(0x20010db8, 0x00000000)).toBe(1);
    expect(at(0x20010db8, 0x7fffffff)).toBe(1);
    expect(at(0x20010db8, 0x80000000)).toBe(2);
    expect(at(0xffffffff, 0xffffffff)).toBe(2);
  });

  it("does not skip a boundary whose first word equals a bucket start", () => {
    // The bracket is widened with a strict `<` for exactly this: the span
    // begins above the bucket start once the low words are read.
    const stride = 2;
    const bits = 8;
    const shift = 32 - bits;
    const bucketStart = (3 << shift) >>> 0;
    const starts = build(stride, [
      [0, 0],
      [bucketStart, 0x00001000],
    ]);
    const idx = buildIndexN(starts, stride, 2, bits);
    const a = new Uint32Array(4);
    a[0] = bucketStart;
    a[1] = 0;
    // Below the second boundary despite sharing its first word.
    expect(searchStrideN(starts, idx, 2, stride, shift, a)).toBe(0);
    a[1] = 0x00001000;
    expect(searchStrideN(starts, idx, 2, stride, shift, a)).toBe(1);
  });
});
