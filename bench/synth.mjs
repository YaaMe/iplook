/**
 * Generate a corpus with the shape of a real geolocation table.
 *
 * The measurements in the README come from a commercial database that cannot
 * be redistributed, which would leave the numbers unreproducible — the exact
 * fault this project criticises elsewhere. So the properties that drive the
 * result are reproduced instead, and they are the ones that matter:
 *
 *   - a complete partition of IPv4: no overlaps, no gaps, every address covered
 *   - a few hundred values, unevenly distributed, as country codes are
 *   - spans of wildly varying width, since allocations are not uniform
 *   - re-encoded back into CIDR, because that is the form a pipeline hands you
 *     and it is what makes the input an order of magnitude larger than the
 *     shape underneath it
 *
 * Deterministic: the same seed gives the same corpus, so two runs compare.
 *
 *   node bench/synth.mjs 312379 242 > /tmp/synthetic.txt
 *   node --expose-gc bench/compare-libs.mjs /tmp/synthetic.txt
 */

const spans = Number(process.argv[2] ?? 312_379);
const valueCount = Number(process.argv[3] ?? 242);
let seed = Number(process.argv[4] ?? 0x5eed) >>> 0;

function rnd() {
  seed = (seed * 1103515245 + 12345) >>> 0;
  return seed;
}

const values = [];
for (let i = 0; i < valueCount; i++) {
  values.push(String.fromCharCode(65 + (i % 26), 65 + ((i / 26) | 0)));
}

// A few values dominate, as a handful of countries hold most of the space.
function pickValue() {
  const r = rnd() % 1000;
  if (r < 350) return values[0];
  if (r < 500) return values[1 + (rnd() % 4)];
  return values[rnd() % valueCount];
}

const out = [];
let addr = 0;
const avg = Math.floor(2 ** 32 / spans);
let prev = null;

for (let i = 0; i < spans && addr <= 0xffffffff; i++) {
  // Width varies over three orders of magnitude, which is what makes the CIDR
  // re-encoding of a span cost more than one block.
  const spread = 1 + (rnd() % 100);
  let width = Math.max(1, Math.floor((avg * spread) / 50));
  if (addr + width > 0x100000000) width = 0x100000000 - addr;

  let v = pickValue();
  // Adjacent spans must differ, or they would have merged and the corpus would
  // not have the span count it claims.
  while (v === prev && valueCount > 1) v = pickValue();
  prev = v;

  // Minimal CIDR cover of [addr, addr + width - 1].
  let c = addr;
  const end = addr + width - 1;
  while (c <= end) {
    let len = c === 0 ? 0 : 32 - (31 - Math.clz32(c & -c));
    for (;;) {
      const sz = len === 0 ? 2 ** 32 : 2 ** (32 - len);
      if (c + sz - 1 <= end) break;
      len++;
    }
    out.push(
      `${(c >>> 24) & 255}.${(c >>> 16) & 255}.${(c >>> 8) & 255}.${c & 255}/${len},${v}`,
    );
    const sz = len === 0 ? 2 ** 32 : 2 ** (32 - len);
    if (c + sz > end) break;
    c += sz;
  }
  addr = end + 1;
}

process.stdout.write(`${out.join("\n")}\n`);
process.stderr.write(`${out.length} prefixes, ${spans} spans, ${valueCount} values\n`);
