/**
 * The arbiter. Obviously correct, uselessly slow.
 *
 * Every other test in this suite is a claim that something faster agrees with
 * this. It scans the original input blocks and keeps the most specific match,
 * which is the definition the rest of the library is trying to implement
 * efficiently.
 */

import { NO_VALUE } from "../src/format.js";

export interface RefBlock {
  start: number;
  len: number;
  id: number;
}

export function refLookup(blocks: readonly RefBlock[], addr: number): number {
  let bestLen = -1;
  let best = NO_VALUE;
  const a = addr >>> 0;

  for (const b of blocks) {
    const size = b.len === 0 ? 2 ** 32 : 2 ** (32 - b.len);
    const lo = b.start >>> 0;
    const hi = lo + size - 1;
    if (a >= lo && a <= hi && b.len > bestLen) {
      bestLen = b.len;
      best = b.id;
    }
  }
  return best;
}

/** Read a partition the way the runtime will: the last start at or below `addr`. */
export function partitionLookup(
  starts: Uint32Array,
  values: Uint32Array,
  addr: number,
): number {
  const a = addr >>> 0;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (starts[mid]! <= a) lo = mid;
    else hi = mid - 1;
  }
  return values[lo]!;
}
