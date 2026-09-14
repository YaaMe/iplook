/**
 * What each index width costs and buys, on one table.
 *
 *   for b in 14 16 18 20 22; do node bench/index-tradeoff.mjs table.iplk $b; done
 *
 * One width per process on purpose. Timing several in a single process lets
 * the earlier ones warm the JIT for the later ones, and the bias is monotonic
 * — it makes wider indexes look better than they are, which is exactly the
 * conclusion under test.
 */

import { readFileSync } from "node:fs";
import { IpTable } from "../dist/index.js";

const bytes = readFileSync(process.argv[2]);
const bits = process.argv[3] ? Number(process.argv[3]) : undefined;
const t = new IpTable(bytes, bits === undefined ? {} : { index: bits });

const N = 8192;
const nums = new Uint32Array(N);
const strs = new Array(N);
let seed = 0xc0ffee;
for (let i = 0; i < N; i++) {
  seed = (seed * 1103515245 + 12345) >>> 0;
  nums[i] = seed;
  strs[i] =
    `${(seed >>> 24) & 255}.${(seed >>> 16) & 255}.${(seed >>> 8) & 255}.${seed & 255}`;
}

function measure(fn, iters = 3_000_000) {
  for (let i = 0; i < iters; i++) fn(i);
  const s = [];
  for (let r = 0; r < 10; r++) {
    const t0 = process.hrtime.bigint();
    let acc = 0;
    for (let i = 0; i < iters; i++) acc += fn(i);
    s.push(Number(process.hrtime.bigint() - t0) / iters);
    if (acc === -1) process.stdout.write("");
  }
  s.sort((a, b) => a - b);
  const q1 = s[Math.floor(s.length * 0.25)];
  const q3 = s[Math.floor(s.length * 0.75)];
  const iqr = q3 - q1;
  const kept = s.filter((x) => x >= q1 - 1.5 * iqr && x <= q3 + 1.5 * iqr);
  return kept[Math.floor(kept.length / 2)];
}

const MASK = N - 1;
const search = measure((i) => t.lookupV4(nums[i & MASK]));
const full = measure((i) => t.lookupId(strs[i & MASK]));
const s = t.size;

process.stdout.write(
  `${JSON.stringify({
    bits: s.indexBits.v4,
    spans: s.v4,
    table: s.bytes,
    index: s.indexBytes,
    search,
    full,
  })}\n`,
);
