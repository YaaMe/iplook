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
  const path = argv[0];
  if (!path) {
    process.stderr.write("iplook inspect: need a table\n");
    return 1;
  }
  const t = load(path);
  const s = t.size;
  process.stdout.write(
    `${path}\n` +
      `  IPv4 spans   ${s.v4.toLocaleString()}\n` +
      `  IPv6 spans   ${s.v6.toLocaleString()}\n` +
      `  values       ${t.values.length - 1}\n` +
      `  table bytes  ${(s.bytes / 1048576).toFixed(2)} MB\n` +
      `  file bytes   ${(readFileSync(path).length / 1048576).toFixed(2)} MB\n`,
  );
  return 0;
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
