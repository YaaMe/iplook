import { describe, expect, it } from "vitest";
import { TableBuilder } from "../src/build/builder.js";
import { IpTable } from "../src/table.js";

function build(blocks: readonly [string, string][]): IpTable {
  const b = new TableBuilder();
  for (const [cidr, value] of blocks) b.addPrefix(cidr, value);
  return new IpTable(b.build().buffer);
}

describe("IPv6", () => {
  it("answers within a prefix and outside it", () => {
    const t = build([
      ["2001:db8::/32", "docs"],
      ["2600:1f00::/24", "aws"],
    ]);
    expect(t.lookup("2001:db8::1")).toBe("docs");
    expect(t.lookup("2001:db8:ffff:ffff:ffff:ffff:ffff:ffff")).toBe("docs");
    expect(t.lookup("2001:db9::1")).toBeUndefined();
    expect(t.lookup("2600:1f00::5")).toBe("aws");
  });

  it("resolves nesting by longest prefix", () => {
    const t = build([
      ["2001:db8::/32", "outer"],
      ["2001:db8:1::/48", "inner"],
      ["2001:db8:1:2::/64", "innermost"],
    ]);
    expect(t.lookup("2001:db8:9::1")).toBe("outer");
    expect(t.lookup("2001:db8:1:9::1")).toBe("inner");
    expect(t.lookup("2001:db8:1:2::1")).toBe("innermost");
  });

  it("handles the edges of the space", () => {
    const t = build([
      ["::/128", "zero"],
      ["ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128", "top"],
      ["8000::/1", "upper half"],
    ]);
    expect(t.lookup("::")).toBe("zero");
    expect(t.lookup("::1")).toBeUndefined();
    expect(t.lookup("ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff")).toBe("top");
    expect(t.lookup("8000::1")).toBe("upper half");
    expect(t.lookup("7fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff")).toBeUndefined();
  });

  it("masks an unaligned prefix rather than rejecting it", () => {
    const t = build([["2001:db8::1/32", "masked"]]);
    expect(t.lookup("2001:db8:aaaa::9")).toBe("masked");
  });

  it("keeps the two families apart", () => {
    const t = build([
      ["10.0.0.0/8", "v4"],
      ["2001:db8::/32", "v6"],
    ]);
    expect(t.lookup("10.1.1.1")).toBe("v4");
    expect(t.lookup("2001:db8::1")).toBe("v6");
    expect(t.size.v4).toBeGreaterThan(0);
    expect(t.size.v6).toBeGreaterThan(0);
  });

  it("answers v6 when the table has no v4 at all", () => {
    const t = build([["2001:db8::/32", "only"]]);
    expect(t.size.v4).toBe(0);
    expect(t.lookup("2001:db8::1")).toBe("only");
    expect(t.lookup("1.2.3.4")).toBeUndefined();
  });
});

describe("stride", () => {
  // The whole point of stride: a corpus that never needs the low words should
  // not pay to store them.
  it("uses two words when every boundary is /64-aligned", () => {
    const b = new TableBuilder();
    b.addPrefix("2001:db8::/32", "a");
    b.addPrefix("2001:db9::/32", "b");
    b.addPrefix("2600::/16", "c");
    const t = new IpTable(b.build().buffer);
    // 6 spans at stride 2 is 48 bytes of starts; at stride 4 it would be 96.
    const bytesPerBoundary = (t.size.bytes - t.size.v6) / t.size.v6;
    expect(bytesPerBoundary).toBeLessThan(12);
    expect(t.lookup("2001:db8::1")).toBe("a");
    expect(t.lookup("2600::1")).toBe("c");
  });

  it("widens to four words when one boundary needs them, without changing answers", () => {
    const b = new TableBuilder();
    b.addPrefix("2001:db8::/32", "a");
    b.addPrefix("2001:db9::/32", "b");
    b.addPrefix("2600::/16", "c");
    b.addPrefix("2001:db8::dead:beef/128", "pin"); // forces the low words
    const t = new IpTable(b.build().buffer);

    expect(t.lookup("2001:db8::dead:beef")).toBe("pin");
    expect(t.lookup("2001:db8::dead:bee0")).toBe("a");
    expect(t.lookup("2001:db8::1")).toBe("a");
    expect(t.lookup("2001:db9::1")).toBe("b");
    expect(t.lookup("2600::1")).toBe("c");
  });

  it("carries correctly across a word boundary", () => {
    // A /64 block ends at ...:ffff:ffff:ffff:ffff, so its remove event lands
    // one past it — the carry has to cross two words to get there.
    const t = build([
      ["2001:db8:0:0::/64", "first"],
      ["2001:db8:0:1::/64", "second"],
    ]);
    expect(t.lookup("2001:db8::ffff:ffff:ffff:ffff")).toBe("first");
    expect(t.lookup("2001:db8:0:1::")).toBe("second");
    expect(t.lookup("2001:db8:0:2::")).toBeUndefined();
  });
});

/**
 * The index is derived state for IPv6 exactly as it is for IPv4, so
 * `index: false` must change the cost of an answer and nothing else. It once
 * changed every answer to "no match", because the v6 lookup gave up when there
 * was no index instead of falling back to a plain binary search — and no test
 * noticed, because the only no-index agreement test was IPv4.
 */
describe("the coarse index changes nothing but the speed, for IPv6", () => {
  /** Boundary words per span, read back out of `size`. One byte per value. */
  function strideOf(t: IpTable): number {
    return (t.size.bytes - t.size.v6) / t.size.v6 / 4;
  }

  function hex(words: readonly number[]): string {
    const parts: string[] = [];
    for (const w of words) {
      parts.push(((w >>> 16) & 0xffff).toString(16), (w & 0xffff).toString(16));
    }
    return parts.join(":");
  }

  // Each case adds a block that needs one more boundary word than the last, so
  // the four of them cover every stride the format can emit.
  const cases: { stride: number; blocks: [string, string][] }[] = [
    { stride: 1, blocks: [] },
    { stride: 2, blocks: [["2001:db8:1::/48", "inner"]] },
    { stride: 3, blocks: [["2001:db8:0:0:1::/80", "deep"]] },
    { stride: 4, blocks: [["2001:db8::dead:beef/128", "pin"]] },
  ];

  // Every boundary here is /32-aligned, so the base table is stride 1 and each
  // case's extra block is what widens it. `ffff:ffff::/32` runs to the top of
  // the space, so the last address is covered without forcing the low words.
  const base: [string, string][] = [
    ["2001:db8::/32", "docs"],
    ["2600:1f00::/24", "aws"],
    ["8000::/1", "upper"],
    ["ffff:ffff::/32", "top"],
  ];

  // Hits, gaps, nesting and both ends of the space, plus the address either
  // side of every boundary named above.
  const probes = [
    "::",
    "::1",
    "2001:db7:ffff:ffff:ffff:ffff:ffff:ffff",
    "2001:db8::",
    "2001:db8::1",
    "2001:db8::dead:beee",
    "2001:db8::dead:beef",
    "2001:db8::dead:bef0",
    "2001:db8:0:0:1::",
    "2001:db8:0:0:0:ffff:ffff:ffff",
    "2001:db8:1::",
    "2001:db8:1:ffff:ffff:ffff:ffff:ffff",
    "2001:db8:2::",
    "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff",
    "2001:db9::",
    "2600:1f00::5",
    "2601::",
    "7fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "8000::",
    "8000::1",
    "ffff:ffff:ffff:ffff:ffff:ffff:ffff:fffe",
    "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  ];

  for (const { stride, blocks } of cases) {
    it(`agrees with the unindexed search at stride ${stride}`, () => {
      const b = new TableBuilder();
      for (const [cidr, value] of [...base, ...blocks]) b.addPrefix(cidr, value);
      const buf = b.build().buffer;

      const indexed = new IpTable(buf);
      const plain = new IpTable(buf, { index: false });
      expect(strideOf(indexed)).toBe(stride);

      // The blocks are still reachable, so "they agree" is not two silences
      // agreeing with each other.
      expect(plain.lookup("2001:db8::1")).toBe("docs");
      expect(plain.lookup("ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff")).toBe("top");

      for (const p of probes)
        expect([p, plain.lookup(p)]).toEqual([p, indexed.lookup(p)]);

      // And across the space: a gap is as much an answer as a hit.
      let x = 0x9e3779b9;
      for (let i = 0; i < 4000; i++) {
        const words: number[] = [];
        for (let k = 0; k < 4; k++) {
          x ^= x << 13;
          x ^= x >>> 17;
          x ^= x << 5;
          words.push(x >>> 0);
        }
        const p = hex(words);
        expect([p, plain.lookup(p)]).toEqual([p, indexed.lookup(p)]);
      }
    });
  }

  it("agrees at every explicit index width too", () => {
    const b = new TableBuilder();
    for (const [cidr, value] of [...base, ...cases[3]!.blocks]) b.addPrefix(cidr, value);
    const buf = b.build().buffer;

    const tables = [4, 8, 16, 24].map((w) => new IpTable(buf, { index: w }));
    tables.push(new IpTable(buf, { index: false }));

    for (const p of probes) {
      const want = tables[0]!.lookup(p);
      for (const t of tables) expect([p, t.lookup(p)]).toEqual([p, want]);
    }
  });
});
