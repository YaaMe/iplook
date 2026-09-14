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

/** Bits of the address used to select an index bucket. */
export const INDEX_BITS = 16;

/**
 * Build the coarse index for a stride-1 (IPv4) table.
 *
 * `idx[b]` is the span containing `b << shift`, so an address in bucket `b`
 * lies in a span somewhere in `[idx[b], idx[b + 1]]`. Because the partition is
 * complete, that bracket always contains the answer.
 */
export function buildIndex1(starts: Uint32Array, bits = INDEX_BITS): Uint32Array {
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
  bits = INDEX_BITS,
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

/** The span containing `v`, for a stride-1 table. */
export function searchStride1(starts: Uint32Array, idx: Uint32Array, v: number): number {
  let lo = idx[v >>> (32 - INDEX_BITS)]!;
  let hi = idx[(v >>> (32 - INDEX_BITS)) + 1]!;
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
  a: Uint32Array,
): number {
  const b = a[0]! >>> (32 - INDEX_BITS);
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
