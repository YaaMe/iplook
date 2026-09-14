/**
 * The value dictionary: intern strings while building, then assign ids.
 *
 * Ids are handed out in sorted order of the value string at the end, not in
 * first-seen order. That is what makes the output byte-identical however the
 * input files happen to be ordered — the artefact is something people commit
 * and diff, so a stable build matters more than a cheaper one.
 */

import { NO_VALUE } from "../format.js";

export class Dict {
  private readonly seen = new Map<string, number>();

  /** Intern `v`, returning a provisional id. Never returns {@link NO_VALUE}. */
  intern(v: string): number {
    if (v === "") return NO_VALUE;
    const existing = this.seen.get(v);
    if (existing !== undefined) return existing;
    const id = this.seen.size + 1;
    this.seen.set(v, id);
    return id;
  }

  get size(): number {
    return this.seen.size + 1;
  }

  /**
   * Finalise: the sorted value list, and a map from provisional id to final id.
   *
   * `values[0]` is always the empty string, so id 0 keeps meaning "no value".
   */
  finalise(): { values: string[]; remap: Uint32Array } {
    const sorted = [...this.seen.keys()].sort();
    const remap = new Uint32Array(this.seen.size + 1);
    const values: string[] = [""];
    for (let i = 0; i < sorted.length; i++) {
      const v = sorted[i]!;
      values.push(v);
      remap[this.seen.get(v)!] = i + 1;
    }
    return { values, remap };
  }
}
