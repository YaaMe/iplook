/**
 * The IPv6 sweep.
 *
 * Same shape as the IPv4 one — events, an active set indexed by prefix length,
 * emit where the winner changes — but addresses are four words, so ordering
 * and the end-of-block arithmetic cannot ride on a single number.
 *
 * Sorting uses a stable comparator rather than a radix pass. IPv6 corpora are
 * orders of magnitude smaller than their IPv4 counterparts (a provider that
 * publishes millions of IPv4 blocks publishes thousands of IPv6 ones, because
 * the allocations are enormous), so the constant factor a radix sort buys is
 * not worth four times the passes and the extra code. Stability is what
 * matters, and the spec has guaranteed it since ES2019.
 */

import { NO_VALUE } from "../format.js";
import type { ConflictPolicy } from "./sweep.js";
import { ConflictError } from "./sweep.js";

export interface SweepInput6 {
  /** Block starts, four words each, most significant first. */
  starts: Uint32Array;
  /** Prefix lengths, 0..128. */
  lens: Uint8Array;
  ids: Uint32Array;
  n: number;
}

export interface Partition6 {
  /** Span starts, four words each. */
  starts: Uint32Array;
  values: Uint32Array;
  /** Leading words needed to tell every boundary apart, 1..4. */
  stride: number;
}

/** Compare four-word addresses at `a[ao..ao+4)` and `b[bo..bo+4)`. */
function cmp128(a: Uint32Array, ao: number, b: Uint32Array, bo: number): number {
  for (let k = 0; k < 4; k++) {
    const x = a[ao + k]!;
    const y = b[bo + k]!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Write `start + 2^(128 - len)` into `out[oo..oo+4)`, returning false on
 * overflow.
 *
 * `start` is aligned to its prefix length, so every bit below the one being
 * added is already zero and this is a single increment with carry. Overflow
 * means the block reaches the top of the space, and its remove event is
 * dropped for the same reason as in IPv4: the sweep ends there, so the event
 * could never change an emitted span.
 */
function endPlusOne(
  src: Uint32Array,
  so: number,
  len: number,
  out: Uint32Array,
  oo: number,
): boolean {
  if (len === 0) return false;
  for (let k = 0; k < 4; k++) out[oo + k] = src[so + k]!;

  const bit = 128 - len; // position from the least significant bit
  let w = 3 - (bit >>> 5); // word index counting from the most significant
  let carry = (1 << (bit & 31)) >>> 0; // 1 << 31 is negative without this

  while (w >= 0 && carry !== 0) {
    const sum = out[oo + w]! + (carry >>> 0);
    out[oo + w] = sum >>> 0;
    carry = sum > 0xffffffff ? 1 : 0;
    w--;
  }
  return carry === 0;
}

export function sweepV6(
  input: SweepInput6,
  policy: ConflictPolicy = "longest",
): Partition6 {
  const { starts: bStart, lens: bLen, ids: bId, n } = input;

  if (n === 0) {
    return { starts: new Uint32Array(4), values: Uint32Array.of(NO_VALUE), stride: 1 };
  }

  const maxEvents = 2 * n;
  const evAddr = new Uint32Array(maxEvents * 4);
  const evLen = new Uint8Array(maxEvents);
  const evId = new Uint32Array(maxEvents);
  const evIsAdd = new Uint8Array(maxEvents);

  // Removes first, then adds. The sort below is stable, so at a shared address
  // the departures still run before the arrivals.
  let e = 0;
  for (let i = 0; i < n; i++) {
    if (endPlusOne(bStart, i * 4, bLen[i]!, evAddr, e * 4)) {
      evLen[e] = bLen[i]!;
      evId[e] = bId[i]!;
      evIsAdd[e] = 0;
      e++;
    }
  }
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 4; k++) evAddr[e * 4 + k] = bStart[i * 4 + k]!;
    evLen[e] = bLen[i]!;
    evId[e] = bId[i]!;
    evIsAdd[e] = 1;
    e++;
  }
  const eventCount = e;

  const order = Array.from({ length: eventCount }, (_, i) => i);
  order.sort((x, y) => cmp128(evAddr, x * 4, evAddr, y * 4));

  const activeId = new Uint32Array(129);
  const depth = new Uint32Array(129);
  let highest = -1; // highest occupied prefix length, or -1

  const recomputeHighest = (): void => {
    highest = -1;
    for (let L = 128; L >= 0; L--) {
      if (depth[L]! > 0) {
        highest = L;
        return;
      }
    }
  };

  const outStarts = new Uint32Array((eventCount + 1) * 4);
  const outValues = new Uint32Array(eventCount + 1);
  let out = 1;
  outValues[0] = NO_VALUE; // starts[0..4) is already ::

  let i = 0;
  while (i < eventCount) {
    const at = order[i]! * 4;

    while (i < eventCount && cmp128(evAddr, order[i]! * 4, evAddr, at) === 0) {
      const idx = order[i]!;
      const len = evLen[idx]!;
      const id = evId[idx]!;

      if (evIsAdd[idx] === 1) {
        if (depth[len]! > 0 && activeId[len] !== id) {
          if (policy === "error") {
            throw new ConflictError(
              `two blocks of length /${len} cover the same address with different values`,
            );
          }
          if (policy === "last") activeId[len] = id;
        } else {
          activeId[len] = id;
        }
        depth[len]!++;
        if (len > highest) highest = len;
      } else {
        depth[len]!--;
        if (depth[len] === 0) {
          activeId[len] = NO_VALUE;
          if (len === highest) recomputeHighest();
        }
      }
      i++;
    }

    const w = highest < 0 ? NO_VALUE : activeId[highest]!;
    const atZero =
      evAddr[at] === 0 &&
      evAddr[at + 1] === 0 &&
      evAddr[at + 2] === 0 &&
      evAddr[at + 3] === 0;

    if (atZero) {
      outValues[0] = w;
    } else if (w !== outValues[out - 1]) {
      for (let k = 0; k < 4; k++) outStarts[out * 4 + k] = evAddr[at + k]!;
      outValues[out] = w;
      out++;
    }
  }

  // How many leading words are needed to tell the boundaries apart. A corpus
  // whose every boundary is /64-aligned needs two, halving the table; one
  // boundary with bits below that forces four. The builder never rounds to
  // make this come out smaller — that would change answers.
  let stride = 1;
  for (let s = 4; s > 1; s--) {
    let used = false;
    for (let j = 0; j < out && !used; j++) {
      if (outStarts[j * 4 + (s - 1)] !== 0) used = true;
    }
    if (used) {
      stride = s;
      break;
    }
  }

  const packed = new Uint32Array(out * stride);
  for (let j = 0; j < out; j++) {
    for (let k = 0; k < stride; k++) packed[j * stride + k] = outStarts[j * 4 + k]!;
  }

  return { starts: packed, values: outValues.slice(0, out), stride };
}
