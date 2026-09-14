/**
 * Reading input files without allocating per line.
 *
 * `readFileSync(f).toString().split("\n")` on a ten-million-line corpus creates
 * ten million strings and dominates the build, quite possibly fatally. This
 * scans the bytes and hands back only the slices a line actually needs.
 */

import { createReadStream } from "node:fs";

const NL = 10;
const CR = 13;

/**
 * Call `onLine` for every line in `path`.
 *
 * The callback gets the raw bytes and the bounds of the line within them, so a
 * caller that can parse from bytes never materialises a string at all.
 */
export async function forEachLine(
  path: string,
  onLine: (buf: Uint8Array, start: number, end: number) => void,
): Promise<void> {
  const stream = createReadStream(path, { highWaterMark: 1 << 20 });
  let carry: Uint8Array | null = null;

  for await (const chunk of stream) {
    let buf: Uint8Array = chunk as Uint8Array;
    if (carry) {
      const joined = new Uint8Array(carry.length + buf.length);
      joined.set(carry);
      joined.set(buf, carry.length);
      buf = joined;
      carry = null;
    }

    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== NL) continue;
      let end = i;
      if (end > start && buf[end - 1] === CR) end--;
      onLine(buf, start, end);
      start = i + 1;
    }
    if (start < buf.length) carry = buf.subarray(start).slice();
  }

  if (carry && carry.length > 0) {
    let end = carry.length;
    if (end > 0 && carry[end - 1] === CR) end--;
    if (end > 0) onLine(carry, 0, end);
  }
}
