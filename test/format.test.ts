import { describe, expect, it } from "vitest";
import { TableBuilder } from "../src/build/builder.js";
import { Dict } from "../src/build/dict.js";
import {
  align,
  FORMAT_VERSION,
  FormatError,
  HEADER_LENGTH,
  MAGIC,
  NO_VALUE,
  readHeader,
  SECTION_ALIGN,
  valueWidthFor,
  writeHeader,
} from "../src/format.js";
import { IpTable } from "../src/table.js";

function header() {
  return {
    formatVersion: FORMAT_VERSION,
    minReaderVersion: 1,
    flags: 1,
    v6Stride: 0,
    valueWidth: 1 as const,
    encoding: 0,
    headerLength: HEADER_LENGTH,
    v4Count: 7,
    v4StartsOffset: 64,
    v4ValuesOffset: 96,
    v6Count: 0,
    v6StartsOffset: 0,
    v6ValuesOffset: 0,
    dictCount: 3,
    dictIndexOffset: 104,
    dictBytesOffset: 120,
    dictBytesLength: 5,
    metaOffset: 0,
    metaLength: 0,
  };
}

describe("align", () => {
  it("rounds up to the section boundary and leaves aligned values alone", () => {
    expect(align(0)).toBe(0);
    expect(align(1)).toBe(SECTION_ALIGN);
    expect(align(SECTION_ALIGN)).toBe(SECTION_ALIGN);
    expect(align(SECTION_ALIGN + 1)).toBe(SECTION_ALIGN * 2);
    expect(align(HEADER_LENGTH)).toBe(HEADER_LENGTH);
  });

  it("always produces something a Uint32Array can view", () => {
    for (let n = 0; n < 200; n++) expect(align(n) % 4).toBe(0);
  });
});

describe("valueWidthFor", () => {
  it("picks the narrowest that fits", () => {
    expect(valueWidthFor(1)).toBe(1);
    expect(valueWidthFor(256)).toBe(1);
    expect(valueWidthFor(257)).toBe(2);
    expect(valueWidthFor(65536)).toBe(2);
    expect(valueWidthFor(65537)).toBe(4);
  });

  // Country codes fit a byte; the ~80,000 announced ASNs do not. Assuming one
  // byte would truncate ids silently, so the width is a header field.
  it("widens past what a country table needs", () => {
    expect(valueWidthFor(242)).toBe(1);
    expect(valueWidthFor(80_000)).toBe(4);
  });
});

describe("the header round-trips", () => {
  it("reads back what it wrote", () => {
    const buf = new ArrayBuffer(HEADER_LENGTH);
    const h = header();
    writeHeader(new DataView(buf), h);
    expect(readHeader(new DataView(buf))).toEqual(h);
  });

  it("is little-endian regardless of the platform", () => {
    const buf = new ArrayBuffer(HEADER_LENGTH);
    writeHeader(new DataView(buf), header());
    // "IPLK" as bytes, in that order, is the little-endian spelling of MAGIC.
    expect([...new Uint8Array(buf, 0, 4)]).toEqual([0x49, 0x50, 0x4c, 0x4b]);
    expect(new DataView(buf).getUint32(0, true)).toBe(MAGIC);
  });
});

describe("the header refuses what it cannot read", () => {
  it("rejects a short buffer", () => {
    expect(() => readHeader(new DataView(new ArrayBuffer(8)))).toThrow(FormatError);
  });

  it("rejects bad magic", () => {
    const buf = new ArrayBuffer(HEADER_LENGTH);
    writeHeader(new DataView(buf), header());
    new DataView(buf).setUint32(0, 0xdeadbeef, true);
    expect(() => readHeader(new DataView(buf))).toThrow(/bad magic/);
  });

  // The whole forward-compatibility story: a writer that changes what a
  // section means raises this, and older readers must refuse rather than
  // misinterpret it.
  it("rejects a file that needs a newer reader", () => {
    const buf = new ArrayBuffer(HEADER_LENGTH);
    writeHeader(new DataView(buf), { ...header(), minReaderVersion: 99 });
    expect(() => readHeader(new DataView(buf))).toThrow(/version 99/);
  });

  it("accepts a newer writer that still reads as version 1", () => {
    const buf = new ArrayBuffer(HEADER_LENGTH);
    writeHeader(new DataView(buf), {
      ...header(),
      formatVersion: 7,
      minReaderVersion: 1,
    });
    expect(readHeader(new DataView(buf)).formatVersion).toBe(7);
  });

  it("rejects an encoding and a value width it does not know", () => {
    for (const [field, value, re] of [
      ["encoding", 1, /encoding 1/],
      ["valueWidth", 3, /value width 3/],
    ] as const) {
      const buf = new ArrayBuffer(HEADER_LENGTH);
      writeHeader(new DataView(buf), { ...header(), [field]: value });
      expect(() => readHeader(new DataView(buf))).toThrow(re);
    }
  });

  it("rejects an impossible IPv6 stride", () => {
    const buf = new ArrayBuffer(HEADER_LENGTH);
    writeHeader(new DataView(buf), { ...header(), flags: 3, v6Stride: 5 });
    expect(() => readHeader(new DataView(buf))).toThrow(/stride 5/);
  });
});

describe("the value dictionary", () => {
  it("reserves id 0 for the empty string", () => {
    const d = new Dict();
    expect(d.intern("")).toBe(NO_VALUE);
    expect(d.finalise().values[0]).toBe("");
  });

  it("interns repeats to one id", () => {
    const d = new Dict();
    expect(d.intern("JP")).toBe(d.intern("JP"));
    expect(d.finalise().values).toEqual(["", "JP"]);
  });

  // Ids are assigned in sorted order of the string, not first-seen order, so
  // the artefact does not depend on which file happened to be read first.
  it("assigns ids in sorted order, whatever the insertion order", () => {
    const forward = new Dict();
    for (const v of ["zulu", "alpha", "mike"]) forward.intern(v);
    const backward = new Dict();
    for (const v of ["mike", "alpha", "zulu"]) backward.intern(v);

    expect(forward.finalise().values).toEqual(["", "alpha", "mike", "zulu"]);
    expect(backward.finalise().values).toEqual(forward.finalise().values);
  });

  it("remaps provisional ids onto final ones", () => {
    const d = new Dict();
    const zulu = d.intern("zulu");
    const alpha = d.intern("alpha");
    const { values, remap } = d.finalise();
    expect(values[remap[zulu]!]).toBe("zulu");
    expect(values[remap[alpha]!]).toBe("alpha");
  });
});

describe("what the table reports about itself", () => {
  function build(): ArrayBuffer {
    const b = new TableBuilder();
    b.addPrefix("10.0.0.0/8", "a");
    b.addPrefix("192.168.0.0/16", "b");
    b.addPrefix("2001:db8::/32", "c");
    return b.build().buffer;
  }

  it("reports counts, bytes and the index it chose", () => {
    const t = new IpTable(build());
    const s = t.size;
    expect(s.v4).toBeGreaterThan(0);
    expect(s.v6).toBeGreaterThan(0);
    expect(s.bytes).toBeGreaterThan(0);
    expect(s.indexBits.v4).toBeGreaterThanOrEqual(8);
    expect(s.indexBytes).toBe(
      ((1 << s.indexBits.v4) + 1) * 4 + ((1 << s.indexBits.v6) + 1) * 4,
    );
  });

  it("reports no index heap when there is no index", () => {
    expect(new IpTable(build(), { index: false }).size.indexBytes).toBe(0);
  });

  it("takes an explicit width and reports it", () => {
    const t = new IpTable(build(), { index: 12 });
    expect(t.size.indexBits.v4).toBe(12);
    expect(t.size.indexBytes).toBe(2 * ((1 << 12) + 1) * 4);
  });

  it("refuses a width it cannot honour", () => {
    for (const bad of [3, 25, 2.5, Number.NaN]) {
      expect(() => new IpTable(build(), { index: bad })).toThrow(RangeError);
    }
  });

  // The index is derived state, so it may change the cost of an answer but
  // never the answer.
  it("answers identically at every width", () => {
    const buf = build();
    const widths = [4, 8, 12, 16, 20, 24];
    const tables = widths.map((w) => new IpTable(buf, { index: w }));
    tables.push(new IpTable(buf, { index: false }));

    for (let i = 0; i < 5000; i++) {
      const a = (i * 2654435761) >>> 0;
      const want = tables[0]!.lookupV4(a);
      for (const t of tables) expect(t.lookupV4(a)).toBe(want);
    }
  });
});

/**
 * A view is a promise about how many bytes the caller is offering, and the
 * sections are read off the *underlying* buffer — which, for a Node `Buffer` or
 * any subarray, usually keeps going. A table truncated after its header used to
 * load and answer out of whatever sat next to it: a confident wrong answer,
 * which is the one thing a bundled lookup table must never do.
 */
describe("the loader stays inside the bytes it was given", () => {
  function table(): Uint8Array {
    const b = new TableBuilder();
    b.addPrefix("1.2.3.0/24", "x");
    b.addPrefix("2001:db8::/32", "y");
    return new Uint8Array(b.build().buffer);
  }

  /** `bytes` placed at `offset` in a larger buffer, exposed as `length`. */
  function embed(bytes: Uint8Array, offset: number, length: number): Uint8Array {
    const backing = new Uint8Array(offset + bytes.length + 4096).fill(0xaa);
    backing.set(bytes, offset);
    return new Uint8Array(backing.buffer, offset, length);
  }

  it("rejects a view cut off after the header", () => {
    const t = table();
    expect(() => new IpTable(embed(t, 0, HEADER_LENGTH))).toThrow(FormatError);
    expect(() => new IpTable(embed(t, 0, HEADER_LENGTH))).toThrow(/truncated/);
  });

  it("rejects a view cut off part-way through the sections", () => {
    const t = table();
    const h = readHeader(new DataView(t.buffer, t.byteOffset, t.byteLength));
    const end = h.dictBytesOffset + h.dictBytesLength; // last byte anyone reads

    for (const cut of [HEADER_LENGTH + 8, end >> 1, end - 1]) {
      expect(() => new IpTable(embed(t, 0, cut))).toThrow(FormatError);
    }

    // The bound is the last section, not the file: a writer aligns the tail up
    // to 8 bytes, and those bytes are nobody's data.
    expect(new IpTable(embed(t, 0, end)).lookup("1.2.3.4")).toBe("x");
  });

  // The two offsets take different paths through `normalise`: 8-aligned keeps
  // the caller's buffer and offset, anything else copies. Both have to bound
  // the sections by the view, not by the buffer behind it.
  for (const offset of [8, 64, 3, 9]) {
    it(`bounds by the view, not the buffer, at offset ${offset}`, () => {
      const t = table();
      const whole = new IpTable(embed(t, offset, t.length));
      expect(whole.lookup("1.2.3.4")).toBe("x");
      expect(whole.lookup("2001:db8::1")).toBe("y");

      expect(() => new IpTable(embed(t, offset, HEADER_LENGTH))).toThrow(/truncated/);
    });
  }

  it("still takes a plain ArrayBuffer and an exact view", () => {
    const t = table();
    expect(new IpTable(t.buffer as ArrayBuffer).lookup("1.2.3.4")).toBe("x");
    expect(new IpTable(t).lookup("1.2.3.4")).toBe("x");
  });

  it("rejects a header whose sections do not fit, even with validation off", () => {
    const t = table();
    expect(() => new IpTable(embed(t, 0, HEADER_LENGTH), { validate: false })).toThrow(
      FormatError,
    );
  });

  it("rejects a section offset that would land inside the header", () => {
    const buf = new ArrayBuffer(4096);
    writeHeader(new DataView(buf), { ...header(), v4StartsOffset: 32 });
    expect(() => new IpTable(buf)).toThrow(/overlaps the header/);
  });

  it("rejects a section offset a typed array could not view", () => {
    const buf = new ArrayBuffer(4096);
    writeHeader(new DataView(buf), { ...header(), v4StartsOffset: 66 });
    expect(() => new IpTable(buf)).toThrow(/aligned/);
  });
});
