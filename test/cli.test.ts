import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TableBuilder } from "../src/build/builder.js";
import { serialize } from "../src/build/serialize.js";
import { FLAG_HAS_V4, FLAG_HAS_V6, readHeader, writeHeader } from "../src/format.js";
import { IpTable } from "../src/table.js";

const dir = mkdtempSync(join(tmpdir(), "iplook-cli-"));
const cli = join(dir, "cli", "main.js");
let serial = 0;

beforeAll(async () => {
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  await build({
    entry: ["src/cli/main.ts"],
    outDir: join(dir, "cli"),
    config: false,
    format: ["esm"],
    platform: "node",
    target: "node20",
    silent: true,
  });
}, 30_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(...args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

function input(text: string, name = `input-${serial++}.txt`): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

function table(blocks: readonly (readonly [string, string])[]): string {
  const builder = new TableBuilder();
  for (const [cidr, value] of blocks) builder.addPrefix(cidr, value);
  const path = join(dir, `table-${serial++}.iplk`);
  writeFileSync(path, new Uint8Array(builder.build().buffer));
  return path;
}

describe("verify input arguments", () => {
  it("checks every path following --against, as expanded by a shell glob", () => {
    const a = input("10.0.0.0/8,A");
    const b = input("192.168.0.0/16,B");
    const missing = run("verify", table([["10.0.0.0/8", "A"]]), "--against", a, b);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain("2 blocks checked");
    expect(missing.stderr).toContain("192.168.0.0");

    const complete = table([
      ["10.0.0.0/8", "A"],
      ["192.168.0.0/16", "B"],
    ]);
    expect(run("verify", complete, "--against", a, b).stdout).toContain("2 blocks agree");
    expect(run("verify", complete, "--against", a, "--against", b).status).toBe(0);
  });

  it("preserves input order across repeated options and positional paths", () => {
    const a = input("10.0.0.0/8,A");
    const b = input("10.0.0.0/8,B");
    const result = run(
      "verify",
      table([["10.0.0.0/8", "A"]]),
      "--against",
      a,
      b,
      "--against",
      a,
      "--on-conflict",
      "last",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("3 blocks agree");
  });

  it("rejects extra positionals before --against and missing arguments", () => {
    const path = table([]);
    const source = input("");
    for (const args of [
      [path, source, "--against", source],
      [path, source],
      [path, "--against"],
      ["--against", source],
    ]) {
      const result = run("verify", ...args);
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("agree");
    }
  });
});

describe("verify malformed family declarations", () => {
  it.each([
    ["0.0.0.0/0", FLAG_HAS_V4],
    ["::/0", FLAG_HAS_V6],
  ] as const)("rejects %s when its family flag is cleared", (prefix, flag) => {
    const path = table([[prefix, "A"]]);
    const bytes = readFileSync(path);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const h = readHeader(view);
    writeHeader(view, { ...h, flags: h.flags & ~flag });
    writeFileSync(path, bytes);

    const result = run("verify", path, "--against", input(`${prefix},A`));
    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).not.toContain("blocks agree");
  });
});

describe.each([
  {
    family: "IPv4",
    outer: "10.0.0.0/8",
    first: "10.0.0.0/16",
    inner: "10.1.0.0/16",
    extra: "192.168.0.0/16",
    hostBits: "10.1.2.3/8",
    host: "255.255.255.255/32",
    all: "0.0.0.0/0",
  },
  {
    family: "IPv6",
    outer: "2001:db8::/32",
    first: "2001:db8::/64",
    inner: "2001:db8:1::/48",
    extra: "2001:db9::/32",
    hostBits: "2001:db8::1234/32",
    host: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128",
    all: "::/0",
  },
])("verify the complete $family mapping", (p) => {
  it("rejects incomplete coverage even when the first address matches", () => {
    const result = run(
      "verify",
      table([[p.first, "A"]]),
      "--against",
      input(`${p.outer},A`),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("input says A");
  });

  it("detects a wrong value strictly inside an input prefix", () => {
    const result = run(
      "verify",
      table([
        [p.outer, "A"],
        [p.inner, "B"],
      ]),
      "--against",
      input(`${p.outer},A`),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("table says B, input says A");
  });

  it("detects coverage outside the inputs, including an absent address family", () => {
    const path = table([
      [p.outer, "A"],
      [p.extra, "B"],
    ]);
    expect(run("verify", path, "--against", input(`${p.outer},A`)).status).toBe(1);
    expect(run("verify", path, "--against", input("# empty\n")).status).toBe(1);
  });

  it.each(["longest", "last", "error"])(
    "accepts nested prefixes and host bits with %s",
    (policy) => {
      const path = table([
        [p.outer, "A"],
        [p.first, "B"],
      ]);
      const result = run(
        "verify",
        path,
        "--against",
        input(`${p.hostBits},A\n${p.first},B`),
        "--on-conflict",
        policy,
      );
      expect(result.status, result.stderr).toBe(0);
    },
  );

  it("checks the first and final spans, including a one-address tail", () => {
    expect(run("verify", table([]), "--against", input(`${p.all},A`)).status).toBe(1);
    expect(run("verify", table([[p.host, "A"]]), "--against", input("")).status).toBe(1);
    expect(
      run("verify", table([[p.host, "A"]]), "--against", input(`${p.host},A`)).status,
    ).toBe(0);
  });

  it.each(["longest", "last", "error"])(
    "matches build with the %s conflict policy",
    (policy) => {
      const source = input(`${p.outer},A\n${p.first},B\n${p.first},C`);
      const path = join(dir, `conflict-${serial++}.iplk`);
      const built = run("build", source, "-o", path, "--on-conflict", policy);
      const verified = run(
        "verify",
        policy === "error" ? table([[p.outer, "A"]]) : path,
        "--against",
        source,
        "--on-conflict",
        policy,
      );
      expect(built.status).toBe(policy === "error" ? 1 : 0);
      expect(verified.status, verified.stderr).toBe(built.status);
      if (policy === "error") expect(verified.stderr).toContain("different values");
      else {
        expect(new IpTable(readFileSync(path)).lookup(p.first.split("/")[0]!)).toBe(
          policy === "last" ? "C" : "B",
        );
      }
    },
  );
});

describe("error messages", () => {
  it("name the command exactly once", () => {
    const source = input("10.0.0.0/8", "no-inline-value.txt");
    const cases = [
      ["build", source, "-o", join(dir, `out-${serial++}.iplk`)],
      [
        "build",
        source,
        "--on-conflict",
        "bogus",
        "-o",
        join(dir, `out-${serial++}.iplk`),
      ],
      ["verify", "--against", source],
    ];
    for (const args of cases) {
      const result = run(...args);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(new RegExp(`^iplook ${args[0]}: `));
      expect(result.stderr.match(/iplook( \w+)?: /g)).toHaveLength(1);
    }
  });
});

describe("build --value-from-filename", () => {
  it("rejects a file name the pattern does not match, even when every line has a value", () => {
    const source = input("10.0.0.0/8,JP\n192.168.0.0/16,US", "noext");
    const result = run(
      "build",
      source,
      "--value-from-filename",
      "-o",
      join(dir, `out-${serial++}.iplk`),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`iplook build: no value in file name: ${source}\n`);
  });
});

describe("build and verify input semantics", () => {
  it("accepts inline values in files with no extension and rejects missing values", () => {
    const source = input("10.0.0.0/8,A", "without-extension");
    expect(run("verify", table([["10.0.0.0/8", "A"]]), "--against", source).status).toBe(
      0,
    );
    expect(
      run("verify", table([]), "--against", input("10.0.0.0/8", "no-value")).status,
    ).toBe(1);
  });

  it("compares mappings across different dictionary IDs and redundant boundaries", () => {
    const buffer = serialize({
      v4Starts: Uint32Array.of(0, 0x0a000000, 0x0a010000, 0x0b000000),
      v4Values: Uint32Array.of(0, 2, 2, 0),
      v6Starts: Uint32Array.of(
        0,
        0,
        0,
        0,
        0x20010db8,
        0,
        0,
        0,
        0x20010db8,
        1,
        0,
        0,
        0x20010db9,
        0,
        0,
        0,
      ),
      v6Values: Uint32Array.of(0, 3, 3, 0),
      v6Stride: 4,
      values: ["", "0-unused", "A", "B"],
    });
    const path = join(dir, "redundant.iplk");
    writeFileSync(path, new Uint8Array(buffer));
    const source = input("10.0.0.0/8,A\n2001:db8::/32,B");
    const result = run("verify", path, `--against=${source}`);
    expect(result.status, result.stderr).toBe(0);
  });

  it("accepts filename values, comments, blank inline values and custom patterns", () => {
    const source = input("# header\n10.0.0.1/8, # fallback\r\n\n", "region_JP.txt");
    const path = table([["10.0.0.0/8", "JP"]]);
    expect(run("verify", path, "--against", source).status).toBe(0);
    expect(
      run("verify", path, "--against", source, "--value-pattern", "region_(.*)\\.txt")
        .status,
    ).toBe(0);
  });

  it("supports the same fixed value as build", () => {
    const source = input("10.0.0.0/8\n192.168.0.0/16,inline");
    const path = join(dir, "fixed.iplk");
    expect(run("build", source, "--value", "fixed", "-o", path).status).toBe(0);
    expect(run("verify", path, "--against", source, "--value", "fixed").status).toBe(0);
  });

  it("rejects unknown conflict policies in build and verify", () => {
    const source = input("10.0.0.0/8,A");
    expect(
      run("build", source, "-o", join(dir, "invalid.iplk"), "--on-conflict", "typo")
        .status,
    ).toBe(1);
    expect(
      run("verify", table([]), "--against", source, "--on-conflict", "typo").status,
    ).toBe(1);
  });

  it("builds mapped IPv6 CIDRs and verifies their IPv4 equivalent", () => {
    const source = input("::ffff:192.0.2.7/120,mapped");
    const path = join(dir, "mapped.iplk");
    const built = run("build", source, "-o", path);
    expect(built.status, built.stderr).toBe(0);
    expect(new IpTable(readFileSync(path)).lookup("192.0.2.42")).toBe("mapped");
    expect(run("verify", path, "--against", input("192.0.2.0/24,mapped")).status).toBe(0);
  });
});
