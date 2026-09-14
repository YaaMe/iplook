/**
 * Compare against the JavaScript libraries that answer the same question.
 *
 *   npm i longest-prefix-match cidr-tools ipaddr.js
 *   node --expose-gc bench/compare-libs.mjs <cidr-file>
 *
 * Includes bucketing by mask length, the other structural answer to this
 * question, written with the same care as the rest: integer keys, one map per
 * prefix length, nothing allocated per lookup, and the same hand-rolled
 * address parser, so what is being compared is the structure.
 *
 * Not a dependency of this package: these are installed by hand when the
 * comparison is re-run. Every implementation is checked to agree on the probes
 * before any of them is timed, and each takes the address as a string, which
 * is the form a Worker has.
 */
import { readFileSync } from "node:fs";
import { containsCidr } from "cidr-tools";
import ipaddr from "ipaddr.js";
import LongestPrefixMatch from "longest-prefix-match";
import { BartJS } from "./bart-reference.mjs";

const { IpTable } = await import("/Users/yaame/workspace/yaame/iplook/dist/index.js");
const { TableBuilder } = await import(
  "/Users/yaame/workspace/yaame/iplook/dist/build.js"
);

const file = process.argv[2];
const LIMIT = Number(process.argv[3] ?? Infinity);
// Each row is a block and, optionally, a value: "1.2.3.0/24" or
// "1.2.3.0/24,JP". Splitting once here means no structure below has to
// re-parse the line, and every one of them is given the same thing.
let rows = readFileSync(file, "utf8")
  .split("\n")
  .map((l) => l.split("#")[0].trim())
  .filter((l) => l !== "")
  .map((l) => {
    const sep = l.search(/[\s,;]/);
    return sep < 0
      ? { block: l, value: "in" }
      : { block: l.slice(0, sep), value: l.slice(sep + 1).trim() };
  });
if (rows.length > LIMIT) rows = rows.slice(0, LIMIT);
const lines = rows.map((r) => r.block);
const values = rows.map((r) => r.value);

/**
 * Retained bytes, counting ArrayBuffer backing stores.
 *
 * `heapUsed` alone does not: in V8 a typed array's storage is external, so a
 * structure that is one ArrayBuffer measures as very nearly nothing — which is
 * exactly what iplook is, and leaving `arrayBuffers` out understates it in its
 * own favour by more than ten times.
 */
function retained(build) {
  const total = () => {
    const m = process.memoryUsage();
    return m.heapUsed + m.arrayBuffers;
  };
  globalThis.gc();
  globalThis.gc();
  const before = total();
  const h = build();
  globalThis.gc();
  globalThis.gc();
  return { bytes: total() - before, handle: h, ms: 0 };
}
function timedRetained(build) {
  const t = Date.now();
  const r = retained(build);
  r.ms = Date.now() - t;
  return r;
}

/** The same allocation-free parse the library uses, so the comparison is even. */
function parseV4(s) {
  let v = 0;
  let i = 0;
  for (let octet = 0; octet < 4; octet++) {
    let d = 0;
    let digits = 0;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c < 48 || c > 57) break;
      d = d * 10 + (c - 48);
      digits++;
      i++;
    }
    if (digits === 0 || d > 255) return -1;
    v = (v << 8) | d;
    if (octet < 3) {
      if (s.charCodeAt(i) !== 46) return -1;
      i++;
    }
  }
  return v >>> 0;
}

/**
 * Bucketing by mask length: group prefixes by length, key on the masked
 * address, probe longest first. This is the shape of the structure the author
 * reached for twice before, and the cost it cannot escape is one probe per
 * distinct prefix length in the corpus.
 */
function buildBuckets(cidrs) {
  const byLen = new Array(33).fill(null);
  const masks = new Uint32Array(33);
  for (let l = 0; l <= 32; l++) masks[l] = l === 0 ? 0 : (0xffffffff << (32 - l)) >>> 0;
  for (const line of cidrs) {
    const slash = line.indexOf("/");
    const v = parseV4(slash < 0 ? line : line.slice(0, slash));
    const len = slash < 0 ? 32 : Number(line.slice(slash + 1));
    if (!byLen[len]) byLen[len] = new Map();
    byLen[len].set((v & masks[len]) >>> 0, 1);
  }
  const order = [];
  for (let l = 32; l >= 0; l--) if (byLen[l]) order.push(l);
  return { byLen, masks, order };
}

function bucketHas(b, ip) {
  const v = parseV4(ip);
  if (v < 0) return false;
  const { byLen, masks, order } = b;
  for (let i = 0; i < order.length; i++) {
    const l = order[i];
    if (byLen[l].get((v & masks[l]) >>> 0) !== undefined) return true;
  }
  return false;
}

const impls = [];

impls.push({
  name: "iplook",
  ...timedRetained(() => {
    const b = new TableBuilder();
    const ids = new Map();
    for (let i = 0; i < lines.length; i++) {
      let id = ids.get(values[i]);
      if (id === undefined) {
        id = b.valueId(values[i]);
        ids.set(values[i], id);
      }
      b.addPrefixId(lines[i], id);
    }
    // IPLOOK_INDEX overrides the automatic width, so a tuned table can be
    // compared on the same footing as everything else.
    const bits = process.env.IPLOOK_INDEX ? Number(process.env.IPLOOK_INDEX) : undefined;
    return new IpTable(b.build().buffer, bits === undefined ? {} : { index: bits });
  }),
  has: (h, ip) => h.lookupId(ip) !== 0,
});

impls.push({
  // A stride-8 multibit trie with ART numbering and popcount compression —
  // the approach gaissmai/bart takes, transcribed here so the comparison is
  // same-language. Path compression is not implemented, which on a complete
  // partition costs nothing: measured, every node carries a prefix and there
  // are no single-child chains to collapse.
  name: "bart (trie)",
  ...timedRetained(() => {
    const t = new BartJS();
    const ids = new Map();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const slash = line.indexOf("/");
      const v = parseV4(slash < 0 ? line : line.slice(0, slash));
      let id = ids.get(values[i]);
      if (id === undefined) {
        id = ids.size + 1;
        ids.set(values[i], id);
      }
      t.insert(v, slash < 0 ? 32 : Number(line.slice(slash + 1)), id);
    }
    return t;
  }),
  has: (h, ip) => {
    const v = parseV4(ip);
    return v >= 0 && h.lookup(v) !== 0;
  },
});

impls.push({
  name: "mask buckets",
  ...timedRetained(() => buildBuckets(lines)),
  has: (h, ip) => bucketHas(h, ip),
});

impls.push({
  name: "longest-prefix-match",
  ...timedRetained(() => {
    const t = new LongestPrefixMatch();
    for (let i = 0; i < lines.length; i++) t.addPrefix(lines[i], { v: values[i] });
    return t;
  }),
  // Returns an array: [] is a miss, not null. Checking `!= null` counts
  // every miss as a hit.
  has: (h, ip) => h.getMatch(`${ip}/32`).length > 0,
});

impls.push({
  name: "ipaddr.js subnetMatch",
  ...timedRetained(() => {
    const ranges = { in: lines.map((l) => ipaddr.parseCIDR(l)) };
    return ranges;
  }),
  has: (h, ip) => ipaddr.subnetMatch(ipaddr.parse(ip), h, "out") === "in",
});

impls.push({
  name: "cidr-tools containsCidr",
  ...timedRetained(() => lines),
  has: (h, ip) => containsCidr(h, ip),
});

// Probes: half hits, half misses, rotating.
const N = 1024;
const strs = new Array(N);
let seed = 0xc0ffee;
for (let i = 0; i < N; i++) {
  if (i % 2 === 0) {
    const [ip] = lines[(i * 7919) % lines.length].split("/");
    const p = ip.split(".").map(Number);
    strs[i] = `${p[0]}.${p[1]}.${p[2]}.${p[3]}`;
  } else {
    seed = (seed * 1103515245 + 12345) >>> 0;
    strs[i] =
      `${(seed >>> 24) & 255}.${(seed >>> 16) & 255}.${(seed >>> 8) & 255}.${seed & 255}`;
  }
}

// Correctness before timing.
const base = impls[0];
console.log(
  `\ncorpus  ${file.replace(/.*\//, "")}  ${lines.length.toLocaleString()} CIDR`,
);
for (const im of impls.slice(1)) {
  let bad = 0;
  for (let i = 0; i < 200; i++) {
    if (im.has(im.handle, strs[i]) !== base.has(base.handle, strs[i])) bad++;
  }
  im.agrees = bad === 0 ? "agrees" : `${bad}/200 differ`;
}
base.agrees = "reference";

function measure(im, budgetMs = 700) {
  // Adaptive: a linear scanner cannot take the same iteration count as an
  // indexed one, and forcing it to would take hours.
  let iters = 64;
  for (;;) {
    const t = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) im.has(im.handle, strs[i & (N - 1)]);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    if (ms > 60 || iters >= 4_000_000) break;
    iters *= 4;
  }
  const s = [];
  for (let r = 0; r < 10; r++) {
    const t = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) im.has(im.handle, strs[i & (N - 1)]);
    s.push(Number(process.hrtime.bigint() - t) / iters);
  }
  s.sort((a, b) => a - b);
  const q1 = s[Math.floor(s.length * 0.25)],
    q3 = s[Math.floor(s.length * 0.75)];
  const iqr = q3 - q1;
  const kept = s.filter((x) => x >= q1 - 1.5 * iqr && x <= q3 + 1.5 * iqr);
  return { ns: kept[Math.floor(kept.length / 2)], iters };
}

const bucketImpl = impls.find((i) => i.name === "mask buckets");
console.log(
  `probe   ${bucketImpl.handle.order.length} distinct prefix lengths in this corpus`,
);
console.log(
  `\n  ${"structure".padEnd(24)} ${"lookup".padStart(12)} ${"retained".padStart(11)} ${"build".padStart(8)}  agreement`,
);
const results = [];
for (const im of impls) {
  const m = measure(im);
  results.push({ name: im.name, ns: m.ns });
  const mem = im.bytes < 0 ? "n/a" : `${(im.bytes / 1048576).toFixed(2)} MB`;
  console.log(
    `  ${im.name.padEnd(24)} ${m.ns.toFixed(1).padStart(9)} ns ${mem.padStart(11)} ${(im.ms + "ms").padStart(8)}  ${im.agrees}`,
  );
}
const fastest = results[0].ns;
console.log();
for (const r of results.slice(1)) {
  console.log(`  iplook is ${(r.ns / fastest).toFixed(0)}x faster than ${r.name}`);
}
