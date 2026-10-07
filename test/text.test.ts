import { describe, expect, it, vi } from "vitest";
import { TableBuilder } from "../src/build/builder.js";
import { IpTable } from "../src/table.js";
import { fromText } from "../src/text.js";

describe("fromText", () => {
  it("treats a bare list as a set", () => {
    const t = fromText(`
      10.0.0.0/8
      192.168.0.0/16
      1.2.3.4
    `);
    expect(t.lookup("10.1.1.1")).toBe("in");
    expect(t.lookup("192.168.5.5")).toBe("in");
    expect(t.lookup("1.2.3.4")).toBe("in");
    expect(t.lookup("8.8.8.8")).toBeUndefined();
  });

  it("takes an inline value", () => {
    const t = fromText("10.0.0.0/8,office\n192.168.0.0/16 home\n172.16.0.0/12;vpn");
    expect(t.lookup("10.1.1.1")).toBe("office");
    expect(t.lookup("192.168.1.1")).toBe("home");
    expect(t.lookup("172.16.0.1")).toBe("vpn");
  });

  it("accepts mapped IPv6 prefixes with IPv6 prefix lengths", () => {
    const t = fromText("::ffff:192.0.2.7/120,mapped\n::ffff:c633:6401/128,host");
    expect(t.lookup("192.0.2.0")).toBe("mapped");
    expect(t.lookup("192.0.2.255")).toBe("mapped");
    expect(t.lookup("192.0.3.0")).toBeUndefined();
    expect(t.lookup("198.51.100.1")).toBe("host");
    expect(t.lookup("198.51.100.2")).toBeUndefined();
  });

  it("skips comments and blank lines", () => {
    const t = fromText("# a list\n\n10.0.0.0/8   # private\n\n  \n");
    expect(t.lookup("10.0.0.1")).toBe("in");
    expect(t.values).toEqual(["", "in"]);
  });

  it("honours a custom default value", () => {
    const t = fromText("10.0.0.0/8", { value: "allow" });
    expect(t.lookup("10.0.0.1")).toBe("allow");
  });

  it("warns when the input is large enough to be a build step", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fromText("10.0.0.0/8\n".repeat(12), { warnAbove: 10 });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatch(/npx iplook build/);
    warn.mockRestore();
  });

  it("stays silent when told to", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fromText("10.0.0.0/8\n".repeat(12), { warnAbove: 0 });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("the two build paths agree", () => {
  // fromText shares the builder rather than reimplementing it, so this is a
  // check that the text parsing produces the same blocks — not that two
  // independent sweeps happen to match.
  it("gives the same table as the builder API", () => {
    const text = ["10.0.0.0/8,private", "10.1.0.0/16,office", "192.168.0.0/16,home"].join(
      "\n",
    );

    const viaText = fromText(text);

    const b = new TableBuilder();
    b.addPrefix("10.0.0.0/8", "private");
    b.addPrefix("10.1.0.0/16", "office");
    b.addPrefix("192.168.0.0/16", "home");
    const viaApi = new IpTable(b.build().buffer);

    // Compare the resolved strings, not the ids: an id is only meaningful
    // against the dictionary of the table that produced it.
    for (let i = 0; i < 50000; i++) {
      const a = (i * 2654435761) >>> 0;
      const s = `${(a >>> 24) & 255}.${(a >>> 16) & 255}.${(a >>> 8) & 255}.${a & 255}`;
      expect(viaText.lookup(s)).toBe(viaApi.lookup(s));
    }
    expect(viaText.values).toEqual(viaApi.values);
  });
});
