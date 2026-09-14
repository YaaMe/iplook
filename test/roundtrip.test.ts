import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { TableBuilder } from "../src/build/builder.js";
import { NO_VALUE } from "../src/format.js";
import { IpTable } from "../src/table.js";
import { type RefBlock, refLookup } from "./reference.js";

function fmt(v: number): string {
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join(".");
}

function buildFrom(blocks: readonly { cidr: string; value: string }[]): IpTable {
  const b = new TableBuilder();
  for (const { cidr, value } of blocks) b.addPrefix(cidr, value);
  return new IpTable(b.build().buffer);
}

describe("build then read", () => {
  it("answers what was put in", () => {
    const t = buildFrom([
      { cidr: "10.0.0.0/8", value: "private" },
      { cidr: "10.1.0.0/16", value: "office" },
      { cidr: "192.168.0.0/16", value: "private" },
    ]);
    expect(t.lookup("10.0.0.1")).toBe("private");
    expect(t.lookup("10.1.2.3")).toBe("office");
    expect(t.lookup("192.168.1.1")).toBe("private");
    expect(t.lookup("8.8.8.8")).toBeUndefined();
  });

  it("answers above 127.255.255.255", () => {
    const t = buildFrom([
      { cidr: "8.0.0.0/8", value: "low" },
      { cidr: "200.0.0.0/8", value: "high" },
      { cidr: "255.255.255.255/32", value: "top" },
    ]);
    expect(t.lookup("200.1.2.3")).toBe("high");
    expect(t.lookup("255.255.255.255")).toBe("top");
    expect(t.lookup("8.1.2.3")).toBe("low");
  });

  it("accepts a bare address and an unmasked prefix", () => {
    const t = buildFrom([
      { cidr: "1.2.3.4", value: "host" },
      { cidr: "10.0.0.1/8", value: "masked" },
    ]);
    expect(t.lookup("1.2.3.4")).toBe("host");
    expect(t.lookup("1.2.3.5")).toBeUndefined();
    expect(t.lookup("10.9.9.9")).toBe("masked");
  });

  it("routes an IPv4-mapped IPv6 address to the v4 table", () => {
    const t = buildFrom([{ cidr: "1.2.3.0/24", value: "x" }]);
    expect(t.lookup("::ffff:1.2.3.4")).toBe("x");
  });

  it("returns undefined rather than throwing on rubbish", () => {
    const t = buildFrom([{ cidr: "1.2.3.0/24", value: "x" }]);
    expect(t.lookup("not an ip")).toBeUndefined();
    expect(t.lookup("")).toBeUndefined();
    expect(t.lookup("999.1.1.1")).toBeUndefined();
  });

  it("keeps the value dictionary sorted with the empty string first", () => {
    const t = buildFrom([
      { cidr: "3.0.0.0/8", value: "zulu" },
      { cidr: "1.0.0.0/8", value: "alpha" },
      { cidr: "2.0.0.0/8", value: "mike" },
    ]);
    expect(t.values).toEqual(["", "alpha", "mike", "zulu"]);
  });

  it("produces byte-identical output whatever the input order", () => {
    const blocks = [
      { cidr: "10.1.0.0/16", value: "office" },
      { cidr: "10.0.0.0/8", value: "private" },
      { cidr: "192.168.0.0/16", value: "home" },
    ];
    const one = new TableBuilder();
    for (const b of blocks) one.addPrefix(b.cidr, b.value);
    const two = new TableBuilder();
    for (const b of [...blocks].reverse()) two.addPrefix(b.cidr, b.value);
    expect(new Uint8Array(two.build().buffer)).toEqual(
      new Uint8Array(one.build().buffer),
    );
  });
});

describe("the coarse index changes nothing but the speed", () => {
  it("agrees with the unindexed search everywhere", () => {
    const b = new TableBuilder();
    for (let i = 0; i < 400; i++) {
      b.addPrefix(`${i % 256}.${(i * 7) % 256}.0.0/16`, `v${i % 13}`);
    }
    const buf = b.build().buffer;
    const indexed = new IpTable(buf);
    const plain = new IpTable(buf, { index: false });

    for (let i = 0; i < 20000; i++) {
      const a = (i * 2654435761) >>> 0;
      expect(indexed.lookupV4(a)).toBe(plain.lookupV4(a));
    }
  });
});

describe("agreement with the reference, end to end", () => {
  const arb = fc.array(
    fc
      .tuple(
        fc.integer({ min: 0, max: 0xffffffff }),
        fc.integer({ min: 0, max: 32 }),
        fc.integer({ min: 1, max: 5 }),
      )
      .map(([addr, len, v]) => {
        const size = len === 0 ? 2 ** 32 : 2 ** (32 - len);
        const start = len === 0 ? 0 : Math.floor(addr / size) * size;
        return { start: start >>> 0, len, id: v };
      }),
    { minLength: 1, maxLength: 30 },
  );

  it("matches a linear scan at every boundary", () => {
    fc.assert(
      fc.property(arb, (blocks: RefBlock[]) => {
        const b = new TableBuilder();
        for (const bl of blocks) b.addPrefix(`${fmt(bl.start)}/${bl.len}`, `v${bl.id}`);
        const t = new IpTable(b.build().buffer);

        const probes = new Set<number>([0, 0xffffffff, 0x7fffffff, 0x80000000]);
        for (const bl of blocks) {
          const size = bl.len === 0 ? 2 ** 32 : 2 ** (32 - bl.len);
          for (const a of [
            bl.start - 1,
            bl.start,
            bl.start + size - 1,
            bl.start + size,
          ]) {
            if (a >= 0 && a <= 0xffffffff) probes.add(a >>> 0);
          }
        }

        for (const a of probes) {
          const want = refLookup(blocks, a);
          const got = t.lookupV4(a);
          const wantStr = want === NO_VALUE ? undefined : `v${want}`;
          const gotStr = got === NO_VALUE ? undefined : t.values[got];
          if (wantStr !== gotStr) return false;
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });
});

describe("loading", () => {
  it("survives a buffer at an awkward byte offset", () => {
    // Node hands out Buffers as views into a shared pool at arbitrary offsets,
    // which is exactly where new Uint32Array(buf, off, n) throws.
    const built = new TableBuilder();
    built.addPrefix("10.0.0.0/8", "x");
    const src = new Uint8Array(built.build().buffer);

    const padded = new Uint8Array(src.length + 3);
    padded.set(src, 3);
    const view = new Uint8Array(padded.buffer, 3, src.length);
    expect(view.byteOffset % 8).not.toBe(0);

    const t = new IpTable(view);
    expect(t.lookup("10.1.1.1")).toBe("x");
  });

  it("refuses a file that is not a table", () => {
    expect(() => new IpTable(new Uint8Array(64).buffer)).toThrow(/bad magic/);
    expect(() => new IpTable(new Uint8Array(3).buffer)).toThrow(/shorter than/);
  });

  it("refuses a table whose partition does not start at zero", () => {
    const built = new TableBuilder();
    built.addPrefix("10.0.0.0/8", "x");
    const buf = built.build().buffer;
    // Corrupt the first span start.
    const t = new IpTable(buf); // sanity: loads before corruption
    expect(t.lookup("10.0.0.1")).toBe("x");
    new DataView(buf).setUint32(64, 1, true);
    expect(() => new IpTable(buf)).toThrow(/does not start at/);
  });
});

describe("input that arrives from a file", () => {
  // A corpus written on a machine with CRLF line endings gives every entry a
  // trailing carriage return. The error it used to produce named the prefix
  // length, which was the one part of the line that was correct.
  it("accepts a trailing carriage return", () => {
    const b = new TableBuilder();
    b.addPrefix("1.0.0.0/24\r", "crlf");
    b.addPrefix("2001:db8::/32\r", "v6");
    const t = new IpTable(b.build().buffer);
    expect(t.lookup("1.0.0.5")).toBe("crlf");
    expect(t.lookup("2001:db8::1")).toBe("v6");
  });

  it("accepts surrounding whitespace", () => {
    const b = new TableBuilder();
    b.addPrefix("  10.0.0.0/8\t", "padded");
    b.addRange(" 192.168.0.0 ", " 192.168.255.255 ", "range");
    const t = new IpTable(b.build().buffer);
    expect(t.lookup("10.1.1.1")).toBe("padded");
    expect(t.lookup("192.168.1.1")).toBe("range");
  });

  it("says what is wrong with a length rather than naming the whole block", () => {
    const b = new TableBuilder();
    expect(() => b.addPrefix("1.2.3.0/99", "x")).toThrow(/length "99".*expected 0 to 32/);
    expect(() => b.addPrefix("2001:db8::/200", "x")).toThrow(
      /length "200".*expected 0 to 128/,
    );
  });
});
