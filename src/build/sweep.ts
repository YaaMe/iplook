/**
 * The sweep: turn a bag of possibly-nested CIDR blocks into a complete,
 * gapless partition of the address space.
 *
 * The result covers every address exactly once, starting at 0. That is what
 * lets the reader store only the start of each span — the next start implies
 * this one's end — and what lets the lookup be a search with no fallback.
 *
 * Addresses not covered by any input block get {@link NO_VALUE}, so a sparse
 * input (an allowlist over a fraction of a percent of the space) and a dense
 * one (a geolocation table covering all of it) produce the same shape and read
 * through the same code path.
 */

import { NO_VALUE } from "../format.js";
import { radixSortIndices } from "./radix.js";

/** How to resolve two blocks that cover an address with different values. */
export type ConflictPolicy = "longest" | "error" | "last";

export interface SweepInput {
  /** Block start addresses. */
  starts: Uint32Array;
  /** Prefix lengths, 0..32. */
  lens: Uint8Array;
  /** Value ids, all >= 1. Id 0 is reserved for "no value". */
  ids: Uint32Array;
  n: number;
}

export interface Partition {
  /** Span starts, ascending, `starts[0] === 0`. */
  starts: Uint32Array;
  /** Value id per span. */
  values: Uint32Array;
}

export class ConflictError extends Error {
  override name = "ConflictError";
}

/** Highest address covered by a /len block starting at `start`. */
function blockEnd(start: number, len: number): number {
  // len === 0 covers everything; `>>> 32` is a no-op in JS, hence the branch.
  return len === 0 ? 0xffffffff : (start + 2 ** (32 - len) - 1) >>> 0;
}

/**
 * Sweep IPv4 blocks into a partition.
 *
 * Nesting is resolved by longest prefix, because that is what IP data means:
 * asked about an address inside both a /16 and a /24, a caller wants the /24.
 * At most one prefix of a given length can cover any address, so the active
 * set is an array indexed by length and needs no priority queue — the winner
 * is the highest occupied index, found with one `Math.clz32`.
 */
export function sweepV4(
  input: SweepInput,
  policy: ConflictPolicy = "longest",
): Partition {
  const { starts: bStart, lens: bLen, ids: bId, n } = input;

  if (n === 0) {
    return { starts: Uint32Array.of(0), values: Uint32Array.of(NO_VALUE) };
  }

  // Events, laid out with every remove first and every add second. The radix
  // sort below is stable, so after sorting by address the removes at a given
  // address still precede the adds. That ordering is load-bearing: a block
  // ending at X-1 and another of the same length beginning at X must not have
  // the arrival clear the departure's slot.
  //
  // A remove lands at end+1, which is 2^32 for a block reaching the top of the
  // space. Such an event can never change an emitted span, since the sweep
  // stops at 2^32, so it is dropped rather than widened to 33 bits.
  const maxEvents = 2 * n;
  const evAddr = new Uint32Array(maxEvents);
  const evLen = new Uint8Array(maxEvents);
  const evId = new Uint32Array(maxEvents);
  const evIsAdd = new Uint8Array(maxEvents);

  let e = 0;
  for (let i = 0; i < n; i++) {
    const end = blockEnd(bStart[i]!, bLen[i]!);
    if (end !== 0xffffffff) {
      evAddr[e] = (end + 1) >>> 0;
      evLen[e] = bLen[i]!;
      evId[e] = bId[i]!;
      evIsAdd[e] = 0;
      e++;
    }
  }
  for (let i = 0; i < n; i++) {
    evAddr[e] = bStart[i]!;
    evLen[e] = bLen[i]!;
    evId[e] = bId[i]!;
    evIsAdd[e] = 1;
    e++;
  }
  const eventCount = e;

  const order = radixSortIndices(evAddr.subarray(0, eventCount), eventCount);

  // Active set, indexed by prefix length. `depth` counts duplicates so that a
  // block appearing twice does not vacate the slot when the first copy ends.
  const activeId = new Uint32Array(33);
  const depth = new Uint32Array(33);
  let maskLo = 0; // bit L set when length L (0..31) is occupied
  let has32 = false;

  const winner = (): number => {
    if (has32) return activeId[32]!;
    if (maskLo === 0) return NO_VALUE;
    return activeId[31 - Math.clz32(maskLo)]!;
  };

  const outStarts = new Uint32Array(eventCount + 1);
  const outValues = new Uint32Array(eventCount + 1);
  let out = 1;
  outStarts[0] = 0;
  outValues[0] = NO_VALUE;

  let i = 0;
  while (i < eventCount) {
    const addr = evAddr[order[i]!]!;

    while (i < eventCount && evAddr[order[i]!] === addr) {
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
        if (len === 32) has32 = true;
        else maskLo |= 1 << len;
      } else {
        depth[len]!--;
        if (depth[len] === 0) {
          activeId[len] = NO_VALUE;
          if (len === 32) has32 = false;
          else maskLo &= ~(1 << len);
        }
      }
      i++;
    }

    const w = winner();
    if (addr === 0) {
      outValues[0] = w;
    } else if (w !== outValues[out - 1]) {
      outStarts[out] = addr;
      outValues[out] = w;
      out++;
    }
  }

  return { starts: outStarts.slice(0, out), values: outValues.slice(0, out) };
}

/**
 * Decompose the inclusive range `[lo, hi]` into CIDR blocks, calling `emit`
 * for each.
 *
 * Ranges are turned into prefixes on the way in rather than swept directly,
 * because "the most specific block wins" is only well defined over prefixes,
 * and because it is what bounds the active set to 33 entries.
 */
export function rangeToBlocks(
  lo: number,
  hi: number,
  emit: (start: number, len: number) => void,
): void {
  let cur = lo >>> 0;
  const end = hi >>> 0;
  if (cur > end) return;

  for (;;) {
    // The largest block starting here is limited by alignment and by how much
    // of the range is left.
    let len = cur === 0 ? 0 : 32 - lowestSetBitIndex(cur);
    for (;;) {
      const blockSize = len === 0 ? 2 ** 32 : 2 ** (32 - len);
      if (cur + blockSize - 1 <= end) break;
      len++;
    }
    emit(cur, len);

    const size = len === 0 ? 2 ** 32 : 2 ** (32 - len);
    const next = cur + size;
    if (next > end) return;
    cur = next >>> 0;
  }
}

function lowestSetBitIndex(v: number): number {
  return 31 - Math.clz32(v & -v);
}
