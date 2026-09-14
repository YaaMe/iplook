/**
 * Measure the reader on a table the size of a real geolocation corpus.
 *
 * Run with: node bench/lookup.bench.mjs
 *
 * Discipline, because a benchmark that lies is worse than none: correctness is
 * checked before anything is timed, probes rotate rather than repeating one
 * address, ten samples are taken and outliers rejected, and parsing is timed
 * apart from searching — in a Worker the address arrives as a string, so the
 * two together are what a caller actually pays.
 */

import { TableBuilder } from "../dist/build.js";
import { IpTable } from "../dist/index.js";

const SPANS = 312_379; // what a 242-region IPv4 geolocation table collapses to
const VALUES = 242;

function buildCorpus() {
  const b = new TableBuilder();
  const ids = [];
  for (let i = 0; i < VALUES; i++) ids.push(b.valueId(`c${i}`));

  // A random walk of boundaries across the whole space, which is the shape a
  // geolocation table has: a complete partition, no nesting.
  let addr = 0;
  let seed = 0x12345678;
  const step = Math.floor(2 ** 32 / SPANS);
  for (let i = 0; i < SPANS && addr < 0xffffffff; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const width = 1 + (seed % (step * 2));
    const end = Math.min(addr + width, 0xffffffff);
    b.addRangeId(addr, end, ids[seed % VALUES]);
    addr = end + 1;
  }
  return b.build();
}

function probes(n) {
  const out = new Uint32Array(n);
  const strs = new Array(n);
  let seed = 0xdeadbeef;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    out[i] = seed;
    strs[i] =
      `${(seed >>> 24) & 255}.${(seed >>> 16) & 255}.${(seed >>> 8) & 255}.${seed & 255}`;
  }
  return { nums: out, strs };
}

function measure(label, fn, iters = 3_000_000) {
  for (let i = 0; i < iters; i++) fn(i); // warm
  const samples = [];
  for (let run = 0; run < 10; run++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) fn(i);
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / iters);
  }
  samples.sort((a, b) => a - b);
  const q1 = samples[Math.floor(samples.length * 0.25)];
  const q3 = samples[Math.floor(samples.length * 0.75)];
  const iqr = q3 - q1;
  const kept = samples.filter((x) => x >= q1 - 1.5 * iqr && x <= q3 + 1.5 * iqr);
  const median = kept[Math.floor(kept.length / 2)];
  const spread = ((kept[kept.length - 1] - kept[0]) / median) * 100;
  console.log(
    `  ${label.padEnd(34)} ${median.toFixed(1).padStart(7)} ns   ` +
      `(median of ${kept.length}/10, spread ${spread.toFixed(1)}%)`,
  );
  return median;
}

const { buffer, stats } = buildCorpus();
const indexed = new IpTable(buffer);
const plain = new IpTable(buffer, { index: false });
const { nums, strs } = probes(8192);
const MASK = 8191;

// Correctness before timing. A structure that answers wrongly can look fast
// for the wrong reason, and the indexed and unindexed paths must not differ.
for (let i = 0; i < 200_000; i++) {
  const a = nums[i & MASK];
  if (indexed.lookupV4(a) !== plain.lookupV4(a)) {
    throw new Error(`indexed and unindexed disagree at ${a}`);
  }
}

console.log(
  `\ntable   ${stats.spans} spans, ${stats.values} values, ${(stats.bytes / 1048576).toFixed(2)} MB`,
);
console.log(
  `heap    coarse index ${(((1 << 16) + 1) * 4) / 1024} KB, zero bundle bytes\n`,
);

let sink = 0;
const searchPlain = measure("search, plain binary", (i) => {
  sink += plain.lookupV4(nums[i & MASK]);
});
const searchIndexed = measure("search, coarse index", (i) => {
  sink += indexed.lookupV4(nums[i & MASK]);
});
const parseOnly = measure(
  "parse only",
  (i) => {
    sink += strs[i & MASK].length;
  },
  5_000_000,
);
const together = measure("parse + search (what a Worker pays)", (i) => {
  sink += indexed.lookupId(strs[i & MASK]);
});

console.log(
  `\n  index speedup ${(searchPlain / searchIndexed).toFixed(2)}x` +
    `   parse share of the total ${(((together - searchIndexed) / together) * 100).toFixed(0)}%`,
);
console.log(
  `  checksum ${sink & 0xff}   (parse-only row is a loop-overhead floor, not a parse cost)`,
);
