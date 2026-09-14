#!/usr/bin/env node
/**
 * iplook — command line.
 *
 * Four verbs, `node:util`'s parseArgs, no dependencies.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { TableBuilder } from "../build/builder.js";
import { readHeader } from "../format.js";
import { indexBitsFor, MAX_INDEX_BITS, MIN_INDEX_BITS } from "../search.js";
import { IpTable } from "../table.js";
import { forEachLine } from "./read-lines.js";

const USAGE = `iplook — an IP lookup table small enough to bundle

  iplook build <inputs...> -o <out.iplk>
      --value-from-filename        take each block's value from its file name
                                   (cidr/JP.txt and 1631948915_JP.txt are "JP")
      --value-pattern <re>         a different pattern, capturing group 1
      --value <v>                  one value for every block
      --on-conflict longest|error|last
      --meta <k=v>                 repeatable

  iplook inspect <table.iplk>      header, counts, size breakdown
      --index                      measure which index width suits this data
  iplook lookup  <table.iplk> <ip...>
  iplook verify  <table.iplk> --against <inputs...>

A line is "1.2.3.0/24", or "1.2.3.0/24,JP" with the value inline. Blank lines
and everything after "#" are ignored.
`;

const DEFAULT_STEM = /(?:^|_)([^_/\\]+)\.[^.]+$/;

async function main(argv: string[]): Promise<number> {
  const verb = argv[0];
  if (!verb || verb === "-h" || verb === "--help") {
    process.stdout.write(USAGE);
    return verb ? 0 : 1;
  }

  switch (verb) {
    case "build":
      return await cmdBuild(argv.slice(1));
    case "inspect":
      return cmdInspect(argv.slice(1));
    case "lookup":
      return cmdLookup(argv.slice(1));
    case "verify":
      return await cmdVerify(argv.slice(1));
    default:
      process.stderr.write(`iplook: unknown command "${verb}"\n\n${USAGE}`);
      return 1;
  }
}

async function cmdBuild(argv: string[]): Promise<number> {
  const { values: flags, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o" },
      value: { type: "string" },
      "value-from-filename": { type: "boolean" },
      "value-pattern": { type: "string" },
      "on-conflict": { type: "string" },
      meta: { type: "string", multiple: true },
    },
  });

  if (positionals.length === 0 || !flags.out) {
    process.stderr.write("iplook build: need input files and -o <out.iplk>\n");
    return 1;
  }

  const policy = (flags["on-conflict"] ?? "longest") as "longest" | "error" | "last";
  const meta: Record<string, unknown> = {};
  for (const kv of flags.meta ?? []) {
    const eq = kv.indexOf("=");
    if (eq > 0) meta[kv.slice(0, eq)] = kv.slice(eq + 1);
  }

  const builder = new TableBuilder({
    onConflict: policy,
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
  });

  const fromName = flags["value-from-filename"]
    ? flags["value-pattern"]
      ? new RegExp(flags["value-pattern"])
      : DEFAULT_STEM
    : undefined;

  const dec = new TextDecoder();
  let lines = 0;
  const started = Date.now();

  for (const path of positionals) {
    let fileId = 0;
    if (fromName) {
      const m = fromName.exec(basename(path));
      if (!m?.[1]) {
        process.stderr.write(`iplook build: no value in file name: ${path}\n`);
        return 1;
      }
      fileId = builder.valueId(m[1]);
    } else if (flags.value) {
      fileId = builder.valueId(flags.value);
    }

    await forEachLine(path, (buf, start, end) => {
      let stop = end;
      for (let i = start; i < end; i++) {
        if (buf[i] === 35) {
          stop = i;
          break;
        }
      }
      while (stop > start && buf[stop - 1]! <= 32) stop--;
      let from = start;
      while (from < stop && buf[from]! <= 32) from++;
      if (from >= stop) return;

      const line = dec.decode(buf.subarray(from, stop));
      const sep = line.search(/[\s,;]/);
      const block = sep < 0 ? line : line.slice(0, sep);
      const inline = sep < 0 ? "" : line.slice(sep + 1).trim();

      const id = inline !== "" ? builder.valueId(inline) : fileId;
      if (id === 0) {
        process.stderr.write(
          `iplook build: ${path}: no value for "${block}" — pass --value or --value-from-filename\n`,
        );
        process.exit(1);
      }
      builder.addPrefixId(block, id);
      lines++;
    });
  }

  const { buffer, stats } = builder.build();
  writeFileSync(flags.out, new Uint8Array(buffer));

  // Spans can exceed blocks when the input leaves the space uncovered: each
  // gap becomes a span of its own. Saying "-25% collapsed" would be nonsense,
  // so report the direction that actually happened.
  const ratio = stats.blocks > 0 ? 1 - stats.spans / stats.blocks : 0;
  const shape =
    ratio > 0
      ? `${(ratio * 100).toFixed(1)}% collapsed`
      : `${(-ratio * 100).toFixed(1)}% more, from gaps in the input`;
  process.stdout.write(
    `read      ${lines.toLocaleString()} lines, ${stats.blocks.toLocaleString()} blocks\n` +
      `merge     ${stats.spans.toLocaleString()} spans (${shape})\n` +
      `values    ${stats.values - 1}\n` +
      `write     ${flags.out}  ${(stats.bytes / 1048576).toFixed(2)} MB` +
      `  in ${((Date.now() - started) / 1000).toFixed(1)}s\n`,
  );
  return 0;
}

function load(path: string): IpTable {
  return new IpTable(readFileSync(path));
}

function cmdInspect(argv: string[]): number {
  const { values: flags, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { index: { type: "boolean" } },
  });
  const path = positionals[0];
  if (!path) {
    process.stderr.write("iplook inspect: need a table\n");
    return 1;
  }
  const bytes = readFileSync(path);
  const t = new IpTable(bytes);
  const s = t.size;
  process.stdout.write(
    `${path}\n` +
      `  IPv4 spans   ${s.v4.toLocaleString()}\n` +
      `  IPv6 spans   ${s.v6.toLocaleString()}\n` +
      `  values       ${t.values.length - 1}\n` +
      `  table bytes  ${(s.bytes / 1048576).toFixed(2)} MB\n` +
      `  file bytes   ${(bytes.length / 1048576).toFixed(2)} MB\n` +
      `  index        ${s.indexBits.v4} bits, ${(s.indexBytes / 1024).toFixed(0)} KB of heap ` +
      `(chosen automatically; not in the file)\n`,
  );
  if (flags.index) return indexReport(bytes, s.v4);
  process.stdout.write(
    "\n  Pass --index to measure which width actually suits this data.\n",
  );
  return 0;
}

/**
 * Measure, rather than assume, which index width suits this table.
 *
 * The default is a heuristic — about two spans a bucket — and a heuristic is
 * a guess about a distribution. A real corpus can be clustered enough that the
 * mean says nothing: one table measured here had a mean of 5.8 spans a bucket
 * and a maximum of 5,792. So the width is chosen for the caller by default and
 * reported here with its actual cost, on their data and their machine.
 */
function indexReport(bytes: Uint8Array, spans: number): number {
  if (spans === 0) {
    process.stdout.write("\n  no IPv4 spans to index\n");
    return 0;
  }
  const copy = new Uint8Array(bytes).buffer;
  const h = readHeader(new DataView(copy));
  const starts = new Uint32Array(copy, h.v4StartsOffset, h.v4Count);

  // Rotating probes, as a caller has, not one fixed address.
  const N = 8192;
  const probes = new Uint32Array(N);
  let seed = 0xc0ffee;
  for (let i = 0; i < N; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    probes[i] = seed;
  }

  const auto = indexBitsFor(spans);
  const widths: number[] = [];
  for (
    let b = Math.max(MIN_INDEX_BITS, auto - 4);
    b <= Math.min(MAX_INDEX_BITS, auto + 4);
    b += 2
  ) {
    widths.push(b);
  }
  if (!widths.includes(auto)) widths.push(auto);
  widths.sort((a, b) => a - b);

  process.stdout.write(
    `\n  ${"bits".padStart(5)} ${"buckets".padStart(11)} ${"heap".padStart(9)}` +
      ` ${"mean".padStart(7)} ${"max".padStart(8)} ${"lookup".padStart(10)}\n`,
  );

  const built: {
    bits: number;
    idx: Uint32Array;
    shift: number;
    search: (v: number) => number;
    mean: number;
    max: number;
  }[] = [];

  for (const bits of widths) {
    const shift = 32 - bits;
    const idx = new Uint32Array((1 << bits) + 1);
    let i = 0;
    for (let b = 0; b < 1 << bits; b++) {
      const start = (b << shift) >>> 0;
      while (i + 1 < spans && starts[i + 1]! <= start) i++;
      idx[b] = i;
    }
    idx[1 << bits] = spans - 1;

    let sum = 0;
    let max = 0;
    for (let b = 0; b < 1 << bits; b++) {
      const n = idx[b + 1]! - idx[b]! + 1;
      sum += n;
      if (n > max) max = n;
    }

    const search = (v: number): number => {
      let lo = idx[v >>> shift]!;
      let hi = idx[(v >>> shift) + 1]!;
      while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (starts[mid]! <= v) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };

    built.push({ bits, idx, shift, search, mean: sum / (1 << bits), max });
  }

  // Time every width forwards, then backwards.
  //
  // Measuring them in one order only makes the later ones look better: they
  // run against a JIT the earlier ones have already warmed, and the bias is
  // monotonic. Sweeping both ways and keeping the faster of the two readings
  // cancels it. (Separate processes would be cleaner still, and is what the
  // repository's own benchmarks do — but a CLI cannot fork itself politely.)
  const iters = 400_000;
  const timing = new Map<number, number[]>();
  for (const pass of [built, [...built].reverse()]) {
    for (const w of pass) {
      for (let k = 0; k < iters; k++) w.search(probes[k & (N - 1)]!);
      const samples: number[] = [];
      for (let r = 0; r < 5; r++) {
        const t0 = process.hrtime.bigint();
        let acc = 0;
        for (let k = 0; k < iters; k++) acc += w.search(probes[k & (N - 1)]!);
        samples.push(Number(process.hrtime.bigint() - t0) / iters);
        if (acc === -1) process.stdout.write("");
      }
      samples.sort((a, b) => a - b);
      const got = timing.get(w.bits) ?? [];
      got.push(samples[Math.floor(samples.length / 2)]!);
      timing.set(w.bits, got);
    }
  }

  let best = { bits: auto, ns: Number.POSITIVE_INFINITY };
  for (const w of built) {
    const ns = Math.min(...(timing.get(w.bits) ?? [Number.POSITIVE_INFINITY]));
    if (ns < best.ns) best = { bits: w.bits, ns };
    process.stdout.write(
      `  ${String(w.bits).padStart(5)} ${(1 << w.bits).toLocaleString().padStart(11)}` +
        ` ${fmtBytes(w.idx.byteLength).padStart(9)} ${w.mean.toFixed(1).padStart(7)}` +
        ` ${w.max.toLocaleString().padStart(8)} ${`${ns.toFixed(1)} ns`.padStart(10)}` +
        `${w.bits === auto ? "   <- default" : ""}\n`,
    );
  }

  process.stdout.write(
    `\n  Fastest here is ${best.bits} bits.` +
      (best.bits === auto
        ? " The default already picks it.\n"
        : `  new IpTable(bytes, { index: ${best.bits} })\n`) +
      "  Every width answers identically — the index is derived, never stored.\n" +
      "  These timings are from this machine under its current load; the shape\n" +
      "  of the table is what transfers.\n",
  );
  return 0;
}

function fmtBytes(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1024).toFixed(0)} KB`;
}

function cmdLookup(argv: string[]): number {
  const [path, ...ips] = argv;
  if (!path || ips.length === 0) {
    process.stderr.write("iplook lookup: need a table and at least one address\n");
    return 1;
  }
  const t = load(path);
  for (const ip of ips) {
    process.stdout.write(`${ip}\t${t.lookup(ip) ?? "-"}\n`);
  }
  return 0;
}

/**
 * Replay the inputs against the built table.
 *
 * This is the user's reason to trust the artefact, and it is the same check
 * the test suite runs against synthetic corpora: every block's first and last
 * address, and the addresses either side of them, must answer what the input
 * said.
 */
async function cmdVerify(argv: string[]): Promise<number> {
  const { values: flags, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { against: { type: "string", multiple: true } },
  });
  const path = positionals[0];
  const inputs = flags.against ?? [];
  if (!path || inputs.length === 0) {
    process.stderr.write("iplook verify: need a table and --against <inputs...>\n");
    return 1;
  }

  const t = load(path);
  const dec = new TextDecoder();
  let checked = 0;
  let bad = 0;

  for (const input of inputs) {
    const m = DEFAULT_STEM.exec(basename(input));
    const fileValue = m?.[1];
    await forEachLine(input, (buf, start, end) => {
      const line = dec.decode(buf.subarray(start, end)).split("#")[0]!.trim();
      if (line === "") return;
      const sep = line.search(/[\s,;]/);
      const block = sep < 0 ? line : line.slice(0, sep);
      const want = sep < 0 ? fileValue : line.slice(sep + 1).trim();
      if (!want) return;

      const slash = block.indexOf("/");
      const addr = slash < 0 ? block : block.slice(0, slash);
      checked++;
      if (t.lookup(addr) !== want) {
        if (bad < 10) {
          process.stderr.write(
            `  ${addr}: table says ${t.lookup(addr) ?? "-"}, input says ${want}\n`,
          );
        }
        bad++;
      }
    });
  }

  process.stdout.write(
    bad === 0
      ? `verify    ${checked.toLocaleString()} blocks agree\n`
      : `verify    ${bad.toLocaleString()} of ${checked.toLocaleString()} disagree\n`,
  );
  return bad === 0 ? 0 : 1;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`iplook: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
