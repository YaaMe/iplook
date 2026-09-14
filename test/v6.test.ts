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
