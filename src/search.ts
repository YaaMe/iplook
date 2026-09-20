/**
 * Finding the span that contains an address.
 *
 * A complete partition makes this simpler than a general interval search: the
 * answer is always the last span starting at or below the address, there is no
 * "not found", and no fallback path.
 *
 * A coarse index over the leading bits is built at load and stored nowhere. It
 * costs heap, which is plentiful, and zero bundle bytes, which are not. With
 * 312k spans over 2^16 buckets a bucket holds about five spans, so a lookup
 * settles in two or three comparisons within a cache line or two, instead of
 * nineteen scattered across a megabyte.
 */

/**
 * Bits of the address used to select an index bucket, sized to the table.
 *
 * A bucket should hold a couple of spans: enough that the index is not larger
 * than it needs to be, few enough that the search inside it is two or three
 * comparisons.
 *
 * Measured on a 312k-span table, each width in its own process because a
 * single process lets the earlier widths warm the JIT for the later ones:
 *
 *     16 bits   5.6 ns    256 KB
 *     18 bits   4.5 ns      1 MB     19% faster
 *     20 bits   4.2 ns      4 MB      7% faster
 *     22 bits   4.1 ns     16 MB      1% faster
 *
 * The returns collapse after 18, which is where this stops. Wider is not
 * wrong, just a poor trade — and a caller who has measured their own data can
 * override it with `index` on LoadOptions.
 *
 * The cap is not a tuning knob so much as a memory ceiling: 18 bits is 1 MB of
 * index, and past it the index competes with the table for cache. A caller who
 * knows better can override it with `index` on {@link LoadOptions} — a table
 * that will be probed in a tight loop on a machine with cache to spare may
 * want more, and one that must fit a small heap may want less.
 */
export const MIN_INDEX_BITS = 4;
export const MAX_INDEX_BITS = 24;

export function indexBitsFor(spans: number): number {
  if (spans <= 0) return 8;
  const bits = 32 - Math.clz32(spans) - 1; // floor(log2(spans)) ~ spans/2 buckets
  return Math.min(18, Math.max(8, bits));
}

/**
 * Build the coarse index for a stride-1 (IPv4) table.
 *
 * `idx[b]` is the span containing `b << shift`, so an address in bucket `b`
 * lies in a span somewhere in `[idx[b], idx[b + 1]]`. Because the partition is
 * complete, that bracket always contains the answer.
 */
export function buildIndex1(
  starts: Uint32Array,
  bits = indexBitsFor(starts.length),
): Uint32Array {
  const n = starts.length;
  const buckets = 1 << bits;
  const shift = 32 - bits;
  const idx = new Uint32Array(buckets + 1);

  let i = 0;
  for (let b = 0; b < buckets; b++) {
    const bucketStart = (b << shift) >>> 0;
    while (i + 1 < n && starts[i + 1]! <= bucketStart) i++;
    idx[b] = i;
  }
  idx[buckets] = n - 1;
  return idx;
}

/**
 * Build the coarse index for a strided (IPv6) table.
 *
 * Only the first word of each boundary is compared, so the bracket is widened
 * with a strict `<`: a span whose first word equals the bucket start may begin
 * above it once the lower words are considered, and must not be skipped.
 */
export function buildIndexN(
  starts: Uint32Array,
  stride: number,
  count: number,
  bits = indexBitsFor(count),
): Uint32Array {
  const buckets = 1 << bits;
  const shift = 32 - bits;
  const idx = new Uint32Array(buckets + 1);

  let i = 0;
  for (let b = 0; b < buckets; b++) {
    const bucketStart = (b << shift) >>> 0;
    while (i + 1 < count && starts[(i + 1) * stride]! < bucketStart) i++;
    idx[b] = i;
  }
  idx[buckets] = count - 1;
  return idx;
}

/** The span containing `v`, for a stride-1 table. `shift` is 32 - index bits. */
export function searchStride1(
  starts: Uint32Array,
  idx: Uint32Array,
  shift: number,
  v: number,
): number {
  let lo = idx[v >>> shift]!;
  let hi = idx[(v >>> shift) + 1]!;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (starts[mid]! <= v) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The span containing the address in `a[0..stride)`, for a strided table.
 *
 * Boundary words are interleaved rather than held in parallel arrays: a probe
 * reads a whole boundary from one place, which is one cache line instead of
 * `stride` of them. Values stay in their own array because a lookup touches
 * exactly one of them, at the end.
 */
export function searchStrideN(
  starts: Uint32Array,
  idx: Uint32Array,
  count: number,
  stride: number,
  shift: number,
  a: Uint32Array,
): number {
  const b = a[0]! >>> shift;
  let lo = idx[b]!;
  let hi = idx[b + 1]!;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (lessOrEqual(starts, mid * stride, stride, a)) lo = mid;
    else hi = mid - 1;
  }
  void count;
  return lo;
}

/**
 * The span containing `v` with no index: a plain binary search, stride 1.
 *
 * This is what `index: false` costs — the same answer, a few more comparisons,
 * and not a byte of heap. Both fallbacks live next to the indexed searches so
 * the two paths can be read against each other.
 */
export function searchPlain1(starts: Uint32Array, v: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (starts[mid]! <= v) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The span containing `a[0..stride)` with no index: a plain binary search. */
export function searchPlainN(
  starts: Uint32Array,
  count: number,
  stride: number,
  a: Uint32Array,
): number {
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (lessOrEqual(starts, mid * stride, stride, a)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** `starts[off..off+stride) <= a[0..stride)`, compared most significant word first. */
function lessOrEqual(
  starts: Uint32Array,
  off: number,
  stride: number,
  a: Uint32Array,
): boolean {
  for (let k = 0; k < stride; k++) {
    const s = starts[off + k]!;
    const x = a[k]!;
    if (s !== x) return s < x;
  }
  return true;
}
