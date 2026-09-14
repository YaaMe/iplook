/**
 * Compare against bucketing by mask length — the other way to answer this.
 *
 *   node --expose-gc bench/compare-buckets.mjs <cidr-file>
 *
 * The bucketing here is written with the same care as the thing it is compared
 * against: integer keys, one map per prefix length, nothing allocated per
 * lookup. A version that builds strings per lookup measures its own string
 * handling rather than the idea.
 */
import { readFileSync } from "node:fs";

const { IpTable } = await import("/Users/yaame/workspace/yaame/iplook/dist/index.js");
const { TableBuilder } = await import(
  "/Users/yaame/workspace/yaame/iplook/dist/build.js"
);

const file = process.argv[2];
const lines = readFileSync(file, "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "");

/**
 * Mask bucketing, implemented with the same care as the thing it is compared
 * against: integer keys, one Map per prefix length, nothing allocated per
 * lookup. This is the idea behind cidrange-go and behind the 2021 draft —
 * bucket by mask length, key on the masked prefix, probe longest first — with
 * the string handling that dominated the draft taken out of the picture.
 */
function buildBuckets(cidrs) {
  const byLen = new Array(33).fill(null);
  const masks = new Uint32Array(33);
  for (let l = 0; l <= 32; l++) masks[l] = l === 0 ? 0 : (0xffffffff << (32 - l)) >>> 0;

  for (const line of cidrs) {
    const slash = line.indexOf("/");
    const ip = slash < 0 ? line : line.slice(0, slash);
    const len = slash < 0 ? 32 : Number(line.slice(slash + 1));
    const p = ip.split(".");
    const v =
      ((Number(p[0]) << 24) |
        (Number(p[1]) << 16) |
        (Number(p[2]) << 8) |
        Number(p[3])) >>>
      0;
    if (!byLen[len]) byLen[len] = new Map();
    byLen[len].set((v & masks[len]) >>> 0, 1);
  }
  // Probe order: longest prefix first, skipping lengths with no entries.
  const order = [];
  for (let l = 32; l >= 0; l--) if (byLen[l]) order.push(l);
  return { byLen, masks, order };
}

function bucketLookup(b, v) {
  const { byLen, masks, order } = b;
  for (let i = 0; i < order.length; i++) {
    const l = order[i];
    if (byLen[l].get((v & masks[l]) >>> 0) !== undefined) return true;
  }
  return false;
}

function retained(build) {
  globalThis.gc();
  globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  const h = build();
  globalThis.gc();
  globalThis.gc();
  return { bytes: process.memoryUsage().heapUsed - before, handle: h };
}

const t0 = Date.now();
const buckets = retained(() => buildBuckets(lines));
const bucketMs = Date.now() - t0;

const t1 = Date.now();
const table = retained(() => {
  const b = new TableBuilder();
  const id = b.valueId("in");
  for (const l of lines) b.addPrefixId(l, id);
  return new IpTable(b.build().buffer);
});
const tableMs = Date.now() - t1;

const N = 8192;
const nums = new Uint32Array(N);
let seed = 0xc0ffee;
for (let i = 0; i < N; i++) {
  if (i % 2 === 0) {
    const [ip] = lines[(i * 7919) % lines.length].split("/");
    const p = ip.split(".");
    nums[i] =
      ((Number(p[0]) << 24) |
        (Number(p[1]) << 16) |
        (Number(p[2]) << 8) |
        Number(p[3])) >>>
      0;
  } else {
    seed = (seed * 1103515245 + 12345) >>> 0;
    nums[i] = seed;
  }
}

let disagree = 0;
for (let i = 0; i < N; i++) {
  if (bucketLookup(buckets.handle, nums[i]) !== (table.handle.lookupV4(nums[i]) !== 0))
    disagree++;
}

function measure(label, fn, iters = 1_000_000) {
  for (let i = 0; i < iters; i++) fn(i);
  const s = [];
  for (let r = 0; r < 10; r++) {
    const t = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) fn(i);
    s.push(Number(process.hrtime.bigint() - t) / iters);
  }
  s.sort((a, b) => a - b);
  const q1 = s[Math.floor(s.length * 0.25)],
    q3 = s[Math.floor(s.length * 0.75)];
  const iqr = q3 - q1;
  const kept = s.filter((x) => x >= q1 - 1.5 * iqr && x <= q3 + 1.5 * iqr);
  const med = kept[Math.floor(kept.length / 2)];
  console.log(`  ${label.padEnd(32)} ${med.toFixed(1).padStart(8)} ns`);
  return med;
}

const lensUsed = buckets.handle.order.length;
console.log(
  `\ncorpus  ${file.replace(/.*\//, "")}  ${lines.length.toLocaleString()} CIDR`,
);
console.log(
  `agree   ${disagree === 0 ? "identical on all " + N + " probes" : disagree + "/" + N + " disagree"}`,
);
console.log(`        mask buckets probe ${lensUsed} prefix lengths, longest first\n`);
console.log(
  `  ${"structure".padEnd(32)} ${"retained".padStart(11)} ${"build".padStart(8)}`,
);
console.log(
  `  ${"mask buckets, integer keys".padEnd(32)} ${(buckets.bytes / 1048576).toFixed(2).padStart(8)} MB ${(bucketMs + "ms").padStart(8)}`,
);
console.log(
  `  ${"iplook partition".padEnd(32)} ${(table.bytes / 1048576).toFixed(2).padStart(8)} MB ${(tableMs + "ms").padStart(8)}\n`,
);

const MASK = N - 1;
let sink = 0;
const a = measure("mask buckets", (i) => {
  sink += bucketLookup(buckets.handle, nums[i & MASK]) ? 1 : 0;
});
const b = measure("iplook", (i) => {
  sink += table.handle.lookupV4(nums[i & MASK]);
});
console.log(
  `\n  lookup ${(a / b).toFixed(1)}x   memory ${(buckets.bytes / table.bytes).toFixed(1)}x   checksum ${sink & 255}`,
);
