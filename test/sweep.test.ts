import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { rangeToBlocks, type SweepInput, sweepV4 } from "../src/build/sweep.js";
import { NO_VALUE } from "../src/format.js";
import { partitionLookup, type RefBlock, refLookup } from "./reference.js";

function toInput(blocks: readonly RefBlock[]): SweepInput {
  const n = blocks.length;
  const starts = new Uint32Array(n);
  const lens = new Uint8Array(n);
  const ids = new Uint32Array(n);
  blocks.forEach((b, i) => {
    starts[i] = b.start;
    lens[i] = b.len;
    ids[i] = b.id;
  });
  return { starts, lens, ids, n };
}

function sweep(blocks: readonly RefBlock[]) {
  return sweepV4(toInput(blocks));
}

/** Every address where behaviour can change: each boundary and its neighbours. */
function probesFor(blocks: readonly RefBlock[], starts: Uint32Array): number[] {
  const set = new Set<number>([0, 0xffffffff, 0x7fffffff, 0x80000000]);
  const add = (a: number) => {
    if (a >= 0 && a <= 0xffffffff) set.add(a >>> 0);
  };
  for (const b of blocks) {
    const size = b.len === 0 ? 2 ** 32 : 2 ** (32 - b.len);
    add(b.start);
    add(b.start - 1);
    add(b.start + 1);
    add(b.start + size - 1);
    add(b.start + size);
  }
  for (const s of starts) {
    add(s);
    add(s - 1);
    add(s + 1);
  }
  return [...set];
}

describe("the partition invariants", () => {
  it("covers everything from zero, even with no input", () => {
    const p = sweep([]);
    expect(p.starts[0]).toBe(0);
    expect(p.values[0]).toBe(NO_VALUE);
    expect(p.starts.length).toBe(1);
  });

  it("starts at zero and increases strictly", () => {
    const p = sweep([
      { start: 0x0a000000, len: 8, id: 1 },
      { start: 0xc0a80000, len: 16, id: 2 },
    ]);
    expect(p.starts[0]).toBe(0);
    for (let i = 1; i < p.starts.length; i++) {
      expect(p.starts[i]!).toBeGreaterThan(p.starts[i - 1]!);
    }
  });

  it("never leaves two adjacent spans with the same value", () => {
    // Without coalescing, a sparse table silently doubles in size.
    const p = sweep([
      { start: 0x0a000000, len: 24, id: 1 },
      { start: 0x0a000100, len: 24, id: 1 },
      { start: 0x0a000200, len: 24, id: 1 },
    ]);
    for (let i = 1; i < p.values.length; i++) {
      expect(p.values[i]!).not.toBe(p.values[i - 1]!);
    }
  });
});

describe("agreement with the reference", () => {
  it("resolves nesting by longest prefix", () => {
    const blocks: RefBlock[] = [
      { start: 0x0a000000, len: 8, id: 1 },
      { start: 0x0a0a0000, len: 16, id: 2 },
      { start: 0x0a0a0a00, len: 24, id: 3 },
    ];
    const p = sweep(blocks);
    for (const a of probesFor(blocks, p.starts)) {
      expect(partitionLookup(p.starts, p.values, a)).toBe(refLookup(blocks, a));
    }
    expect(partitionLookup(p.starts, p.values, 0x0a0a0a05)).toBe(3);
    expect(partitionLookup(p.starts, p.values, 0x0a0a0b05)).toBe(2);
    expect(partitionLookup(p.starts, p.values, 0x0a0b0b05)).toBe(1);
    expect(partitionLookup(p.starts, p.values, 0x0b000000)).toBe(NO_VALUE);
  });

  it("handles a block that ends exactly where the next begins", () => {
    // The removes-before-adds ordering exists for this case: same length,
    // touching. Sorted the other way, the arrival is cleared by the departure.
    const blocks: RefBlock[] = [
      { start: 0x01000000, len: 24, id: 1 },
      { start: 0x01000100, len: 24, id: 2 },
    ];
    const p = sweep(blocks);
    expect(partitionLookup(p.starts, p.values, 0x010000ff)).toBe(1);
    expect(partitionLookup(p.starts, p.values, 0x01000100)).toBe(2);
    for (const a of probesFor(blocks, p.starts)) {
      expect(partitionLookup(p.starts, p.values, a)).toBe(refLookup(blocks, a));
    }
  });

  it("handles the edges of the space", () => {
    const blocks: RefBlock[] = [
      { start: 0, len: 32, id: 1 },
      { start: 0xffffffff, len: 32, id: 2 },
      { start: 0x80000000, len: 1, id: 3 },
    ];
    const p = sweep(blocks);
    expect(partitionLookup(p.starts, p.values, 0)).toBe(1);
    expect(partitionLookup(p.starts, p.values, 0xffffffff)).toBe(2);
    expect(partitionLookup(p.starts, p.values, 0x80000001)).toBe(3);
    expect(partitionLookup(p.starts, p.values, 1)).toBe(NO_VALUE);
  });

  it("handles a default route under everything", () => {
    const blocks: RefBlock[] = [
      { start: 0, len: 0, id: 9 },
      { start: 0x0a000000, len: 8, id: 1 },
    ];
    const p = sweep(blocks);
    expect(partitionLookup(p.starts, p.values, 0)).toBe(9);
    expect(partitionLookup(p.starts, p.values, 0x0a000001)).toBe(1);
    expect(partitionLookup(p.starts, p.values, 0xffffffff)).toBe(9);
    expect(p.values).not.toContain(NO_VALUE);
  });

  it("is idempotent under duplicate blocks", () => {
    const once = sweep([{ start: 0x0a000000, len: 8, id: 1 }]);
    const twice = sweep([
      { start: 0x0a000000, len: 8, id: 1 },
      { start: 0x0a000000, len: 8, id: 1 },
    ]);
    expect([...twice.starts]).toEqual([...once.starts]);
    expect([...twice.values]).toEqual([...once.values]);
  });

  it("does not depend on input order", () => {
    const blocks: RefBlock[] = [
      { start: 0x0a0a0a00, len: 24, id: 3 },
      { start: 0x0a000000, len: 8, id: 1 },
      { start: 0x0a0a0000, len: 16, id: 2 },
    ];
    const a = sweep(blocks);
    const b = sweep([...blocks].reverse());
    expect([...b.starts]).toEqual([...a.starts]);
    expect([...b.values]).toEqual([...a.values]);
  });
});

describe("agreement under generated input", () => {
  const arbBlocks = fc.array(
    fc
      .tuple(
        fc.integer({ min: 0, max: 0xffffffff }),
        fc.integer({ min: 0, max: 32 }),
        fc.integer({ min: 1, max: 6 }),
      )
      .map(([addr, len, id]): RefBlock => {
        const size = len === 0 ? 2 ** 32 : 2 ** (32 - len);
        // Align the start to its prefix length, as a real CIDR would be.
        const start = len === 0 ? 0 : Math.floor(addr / size) * size;
        return { start: start >>> 0, len, id };
      }),
    { minLength: 0, maxLength: 40 },
  );

  it("matches the reference at every boundary", () => {
    fc.assert(
      fc.property(arbBlocks, (blocks) => {
        const p = sweepV4(toInput(blocks));
        for (const a of probesFor(blocks, p.starts)) {
          if (partitionLookup(p.starts, p.values, a) !== refLookup(blocks, a))
            return false;
        }
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it("always produces a valid partition", () => {
    fc.assert(
      fc.property(arbBlocks, (blocks) => {
        const p = sweepV4(toInput(blocks));
        if (p.starts[0] !== 0) return false;
        for (let i = 1; i < p.starts.length; i++) {
          if (p.starts[i]! <= p.starts[i - 1]!) return false;
          if (p.values[i]! === p.values[i - 1]!) return false;
        }
        return true;
      }),
      { numRuns: 300 },
    );
  });
});

describe("bounded exhaustive", () => {
  // 10.0.0.0/8 is 2^24 addresses. Checking every one of them leaves an
  // off-by-one nowhere to hide, and it runs in seconds.
  it("agrees with the reference on all of 10.0.0.0/8", () => {
    const base = 0x0a000000;
    const blocks: RefBlock[] = [
      { start: base, len: 8, id: 1 },
      { start: base + 0x00010000, len: 16, id: 2 },
      { start: base + 0x00010100, len: 24, id: 3 },
      { start: base + 0x00010180, len: 25, id: 4 },
      { start: base + 0x00020000, len: 15, id: 5 },
      { start: base + 0x00ff0000, len: 16, id: 6 },
      { start: base + 0x00fffffe, len: 31, id: 7 },
    ];
    const p = sweepV4(toInput(blocks));

    // A direct scan of the same blocks, but indexed so the check is not
    // quadratic: for each address take the most specific covering block.
    let mismatch = -1;
    for (let a = base; a <= base + 0x00ffffff; a++) {
      if (partitionLookup(p.starts, p.values, a) !== refLookup(blocks, a)) {
        mismatch = a;
        break;
      }
    }
    expect(mismatch).toBe(-1);
  });
});

describe("rangeToBlocks", () => {
  function blocksOf(lo: number, hi: number): RefBlock[] {
    const out: RefBlock[] = [];
    rangeToBlocks(lo, hi, (start, len) => out.push({ start, len, id: 1 }));
    return out;
  }

  it("covers exactly the range", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffffffff }),
        fc.integer({ min: 0, max: 0xffffffff }),
        (a, b) => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          const blocks = blocksOf(lo, hi);
          let covered = 0;
          for (const bl of blocks) {
            covered += bl.len === 0 ? 2 ** 32 : 2 ** (32 - bl.len);
          }
          if (covered !== hi - lo + 1) return false;
          // Aligned, contiguous, in order.
          let cur = lo;
          for (const bl of blocks) {
            if (bl.start !== cur) return false;
            const size = bl.len === 0 ? 2 ** 32 : 2 ** (32 - bl.len);
            if (bl.len !== 0 && bl.start % size !== 0) return false;
            cur = bl.start + size;
          }
          return cur === hi + 1;
        },
      ),
      { numRuns: 500 },
    );
  });

  it("handles the whole space and single addresses", () => {
    expect(blocksOf(0, 0xffffffff)).toEqual([{ start: 0, len: 0, id: 1 }]);
    expect(blocksOf(5, 5)).toEqual([{ start: 5, len: 32, id: 1 }]);
    expect(blocksOf(0xffffffff, 0xffffffff)).toEqual([
      { start: 0xffffffff, len: 32, id: 1 },
    ]);
  });
});
