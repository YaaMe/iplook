import { describe, expect, it } from "vitest";
import { FAMILY_NONE, FAMILY_V4, FAMILY_V6, parseAddr, parseIPv4 } from "../src/parse.js";

const out = new Uint32Array(4);

function v4(s: string): number {
  const fam = parseAddr(s, out);
  return fam === FAMILY_V4 ? out[0]! : -1;
}

function v6(s: string): string | null {
  const fam = parseAddr(s, out);
  if (fam !== FAMILY_V6) return null;
  return [out[0], out[1], out[2], out[3]]
    .map((w) => (w! >>> 0).toString(16).padStart(8, "0"))
    .join(":");
}

describe("parseIPv4", () => {
  it("parses the boundaries of the space", () => {
    expect(parseIPv4("0.0.0.0")).toBe(0);
    expect(parseIPv4("255.255.255.255")).toBe(4294967295);
  });

  // The bug this library is most likely to ship: (a<<24)|... is a negative
  // int32 for anything at or above 128.0.0.0, which compares wrongly against
  // a Uint32Array. Half the address space depends on this test.
  it("returns an unsigned value above 127.255.255.255", () => {
    expect(parseIPv4("128.0.0.0")).toBe(2147483648);
    expect(parseIPv4("128.0.0.0")).toBeGreaterThan(parseIPv4("127.255.255.255"));
    expect(parseIPv4("224.0.0.1")).toBe(3758096385);
    expect(parseIPv4("255.255.255.255")).toBeGreaterThan(parseIPv4("128.0.0.0"));
  });

  it("orders monotonically across the signed boundary", () => {
    const samples = [
      "0.0.0.0",
      "1.2.3.4",
      "127.255.255.255",
      "128.0.0.0",
      "255.255.255.255",
    ];
    const vals = samples.map((s) => parseIPv4(s));
    for (let i = 1; i < vals.length; i++) {
      expect(vals[i]!).toBeGreaterThan(vals[i - 1]!);
    }
  });

  it("parses a bounded slice", () => {
    expect(parseIPv4("xx1.2.3.4yy", 2, 9)).toBe(16909060);
  });

  it.each([
    ["", "empty"],
    ["1.2.3", "too few octets"],
    ["1.2.3.4.5", "too many octets"],
    ["1.2.3.256", "octet out of range"],
    ["1.2.3.4 ", "trailing space"],
    [" 1.2.3.4", "leading space"],
    ["1.2.3.", "trailing dot"],
    [".1.2.3", "leading dot"],
    ["1..2.3", "empty octet"],
    ["1.2.3.4444", "too many digits"],
    ["010.1.1.1", "leading zero is ambiguous"],
    ["1.2.3.0x4", "hex"],
    ["a.b.c.d", "not digits"],
  ])("rejects %j (%s)", (input) => {
    expect(parseIPv4(input)).toBe(-1);
  });

  it("allows a bare zero octet but not a padded one", () => {
    expect(parseIPv4("0.0.0.1")).toBe(1);
    expect(parseIPv4("00.0.0.1")).toBe(-1);
  });
});

describe("parseAddr, IPv6", () => {
  it("parses a full address", () => {
    expect(v6("2001:0db8:0000:0000:0000:ff00:0042:8329")).toBe(
      "20010db8:00000000:0000ff00:00428329",
    );
  });

  it("parses every position of the :: run", () => {
    expect(v6("::")).toBe("00000000:00000000:00000000:00000000");
    expect(v6("::1")).toBe("00000000:00000000:00000000:00000001");
    expect(v6("1::")).toBe("00010000:00000000:00000000:00000000");
    expect(v6("2001:db8::1")).toBe("20010db8:00000000:00000000:00000001");
    expect(v6("2001:db8::")).toBe("20010db8:00000000:00000000:00000000");
    expect(v6("1:2:3:4:5:6:7::")).toBe("00010002:00030004:00050006:00070000");
    expect(v6("::2:3:4:5:6:7:8")).toBe("00000002:00030004:00050006:00070008");
  });

  it("parses the upper boundary", () => {
    expect(v6("ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff")).toBe(
      "ffffffff:ffffffff:ffffffff:ffffffff",
    );
  });

  it("is case insensitive", () => {
    expect(v6("2001:DB8::AbCd")).toBe(v6("2001:db8::abcd"));
  });

  it("parses an embedded dotted quad", () => {
    expect(v6("2001:db8::192.0.2.1")).toBe("20010db8:00000000:00000000:c0000201");
    expect(v6("64:ff9b::192.0.2.33")).toBe("0064ff9b:00000000:00000000:c0000221");
  });

  // ::ffff:a.b.c.d means the IPv4 address, and Cloudflare hands out this form.
  it("unmaps an IPv4-mapped address to the v4 family", () => {
    expect(v4("::ffff:1.2.3.4")).toBe(16909060);
    expect(v4("::ffff:192.168.0.1")).toBe(parseIPv4("192.168.0.1"));
    expect(v4("::ffff:255.255.255.255")).toBe(4294967295);
    expect(v4("::FFFF:1.2.3.4")).toBe(16909060);
    // The hex spelling of the same address is the same address.
    expect(v4("::ffff:102:304")).toBe(16909060);
  });

  it("does not unmap ::1 or a v4-compatible address", () => {
    expect(v6("::1")).not.toBeNull();
    expect(v6("::1.2.3.4")).toBe("00000000:00000000:00000000:01020304");
  });

  it.each([
    ["1:2:3:4:5:6:7", "too few groups"],
    ["1:2:3:4:5:6:7:8:9", "too many groups"],
    ["1::2::3", "two :: runs"],
    [":1:2:3:4:5:6:7:8", "single leading colon"],
    ["1:2:3:4:5:6:7:8:", "trailing single colon"],
    ["1:2:", "trailing single colon"],
    ["1:2:3:4:5:6:7:8::", ":: standing for nothing"],
    ["12345::", "group too long"],
    ["1:2:3:4:5:6:7:zz", "not hex"],
    ["::1.2.3", "bad embedded quad"],
    ["::1.2.3.256", "embedded octet out of range"],
    ["1.2.3.4:5", "quad not at the end"],
    [":", "lone colon"],
  ])("rejects %j (%s)", (input) => {
    expect(parseAddr(input, out)).toBe(FAMILY_NONE);
  });
});

describe("parseAddr, dispatch", () => {
  it("reports the family", () => {
    expect(parseAddr("1.2.3.4", out)).toBe(FAMILY_V4);
    expect(parseAddr("2001:db8::1", out)).toBe(FAMILY_V6);
    expect(parseAddr("nonsense", out)).toBe(FAMILY_NONE);
    expect(parseAddr("", out)).toBe(FAMILY_NONE);
  });

  it("does not leak state between calls", () => {
    expect(v6("2001:db8::1")).toBe("20010db8:00000000:00000000:00000001");
    expect(parseAddr("garbage", out)).toBe(FAMILY_NONE);
    // A failed parse must not corrupt the next one via the shared scratch.
    expect(v6("::2")).toBe("00000000:00000000:00000000:00000002");
    expect(v6("2001:db8::1")).toBe("20010db8:00000000:00000000:00000001");
  });
});
