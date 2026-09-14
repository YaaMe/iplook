/**
 * Stable LSD radix sort over uint32 keys, sorting a permutation rather than
 * the data.
 *
 * Two reasons this is not `Array.prototype.sort`. It is roughly an order of
 * magnitude faster at ten million elements, where a comparator means ten
 * million JS calls. And it is *stable*, which the sweep depends on: events are
 * laid out with every remove before every add, and stability is what keeps
 * removes ahead of adds at the same address after sorting. Getting that
 * ordering backwards silently drops prefixes rather than failing.
 */

/**
 * Return the indices `0..n-1` ordered by `keys`, ascending and stable.
 *
 * `scratch` may be supplied to avoid two allocations when sorting repeatedly.
 */
export function radixSortIndices(
  keys: Uint32Array,
  n: number,
  scratch?: { a: Uint32Array; b: Uint32Array },
): Uint32Array {
  let src = scratch?.a ?? new Uint32Array(n);
  let dst = scratch?.b ?? new Uint32Array(n);
  if (src.length < n || dst.length < n) {
    src = new Uint32Array(n);
    dst = new Uint32Array(n);
  }

  for (let i = 0; i < n; i++) src[i] = i;
  if (n < 2) return src.subarray(0, n);

  const counts = new Uint32Array(256);

  for (let shift = 0; shift < 32; shift += 8) {
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      counts[(keys[src[i]!]! >>> shift) & 0xff]!++;
    }

    // A pass whose digit is constant changes nothing; skipping it is free and
    // saves a full pass on the high bytes of small address spaces.
    if (counts[(keys[src[0]!]! >>> shift) & 0xff] === n) continue;

    let sum = 0;
    for (let d = 0; d < 256; d++) {
      const c = counts[d]!;
      counts[d] = sum;
      sum += c;
    }

    for (let i = 0; i < n; i++) {
      const idx = src[i]!;
      dst[counts[(keys[idx]! >>> shift) & 0xff]!++] = idx;
    }

    const t = src;
    src = dst;
    dst = t;
  }

  return src.subarray(0, n);
}
