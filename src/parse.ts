/**
 * Allocation-free IP address parsing.
 *
 * In a Worker the address arrives as a string on every request, so parsing is
 * on the hot path beside the lookup and is benchmarked separately. Nothing here
 * allocates: no `split`, no `Number()`, no substrings — just `charCodeAt`.
 */

/** Neither a valid IPv4 nor a valid IPv6 address. */
export const FAMILY_NONE = 0;
export const FAMILY_V4 = 4;
export const FAMILY_V6 = 6;

const CH_DOT = 46;
const CH_COLON = 58;
const CH_ZERO = 48;
const CH_NINE = 57;
const CH_A_UPPER = 65;
const CH_F_UPPER = 70;
const CH_A_LOWER = 97;
const CH_F_LOWER = 102;

/**
 * Scratch for IPv6 group assembly, reused rather than allocated per call.
 *
 * Safe because parsing is synchronous and JavaScript is single-threaded: no
 * other call can observe these between the write and the read below.
 */
const parsed = new Uint16Array(8);
const expanded = new Uint16Array(8);

function hexVal(c: number): number {
  if (c >= CH_ZERO && c <= CH_NINE) return c - CH_ZERO;
  if (c >= CH_A_LOWER && c <= CH_F_LOWER) return c - CH_A_LOWER + 10;
  if (c >= CH_A_UPPER && c <= CH_F_UPPER) return c - CH_A_UPPER + 10;
  return -1;
}

/**
 * Parse dotted-quad `s[start..end)` into a uint32, or -1 if it is not one.
 *
 * The return is put through `>>> 0`, and that is not cosmetic. Assembling the
 * address with `(a << 24) | (b << 16) | (c << 8) | d` yields a *negative*
 * int32 for anything at or above 128.0.0.0, because `<<` operates on signed
 * 32-bit integers. Comparing that against a `Uint32Array` read sorts half the
 * address space below zero, and every lookup above 127.255.255.255 answers
 * wrongly — silently, and only for half the internet.
 *
 * -1 is a safe sentinel precisely because `>>> 0` can never produce it.
 */
export function parseIPv4(s: string, start = 0, end = s.length): number {
  let i = start;
  let v = 0;

  for (let octet = 0; octet < 4; octet++) {
    if (i >= end) return -1;

    const first = s.charCodeAt(i);
    if (first < CH_ZERO || first > CH_NINE) return -1;

    let d = 0;
    let digits = 0;
    while (i < end) {
      const c = s.charCodeAt(i);
      if (c < CH_ZERO || c > CH_NINE) break;
      d = d * 10 + (c - CH_ZERO);
      digits++;
      i++;
      if (digits > 3) return -1;
    }
    // Reject leading zeros: "010.1.1.1" is octal to some resolvers and decimal
    // to others, so it is ambiguous rather than merely ugly.
    if (digits > 1 && first === CH_ZERO) return -1;
    if (d > 255) return -1;

    v = (v << 8) | d;

    if (octet < 3) {
      if (i >= end || s.charCodeAt(i) !== CH_DOT) return -1;
      i++;
    }
  }

  if (i !== end) return -1;
  return v >>> 0;
}

/**
 * Parse `s[start..end)` as a decimal prefix length, or -1.
 *
 * Kept here beside the address parsers so the builder and the runtime text
 * loader share one definition of what a CIDR looks like.
 */
export function parsePrefixLen(
  s: string,
  start: number,
  end: number,
  max: number,
): number {
  if (start >= end || end - start > 3) return -1;
  const first = s.charCodeAt(start);
  if (first < CH_ZERO || first > CH_NINE) return -1;
  if (end - start > 1 && first === CH_ZERO) return -1; // "/08"
  let v = 0;
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    if (c < CH_ZERO || c > CH_NINE) return -1;
    v = v * 10 + (c - CH_ZERO);
  }
  return v > max ? -1 : v;
}

/** Index of the first ":" in `s[0..n)`, or -1. */
function indexOfColon(s: string, n: number): number {
  for (let i = 0; i < n; i++) {
    if (s.charCodeAt(i) === CH_COLON) return i;
  }
  return -1;
}

/** Index of the "/" in `s[start..end)`, or -1. */
export function indexOfSlash(s: string, start: number, end: number): number {
  for (let i = start; i < end; i++) {
    if (s.charCodeAt(i) === 47) return i;
  }
  return -1;
}

/**
 * Parse `s` as an address, writing the result into `out`.
 *
 * Returns the family. For {@link FAMILY_V4} only `out[0]` is written, holding
 * the uint32. For {@link FAMILY_V6} all four words are written, most
 * significant first.
 *
 * An IPv4-mapped IPv6 address (`::ffff:1.2.3.4`) is reported as
 * {@link FAMILY_V4} and unmapped into `out[0]`. Cloudflare hands that form out
 * in some configurations, and a caller asking about it means the IPv4 address.
 * The consequence is that whatever an IPv6 table says about `::ffff:0:0/96` is
 * unreachable through this API, which is the right trade and is documented.
 */
export function parseAddr(s: string, out: Uint32Array): number {
  const n = s.length;
  if (n === 0) return FAMILY_NONE;

  // Try IPv4 first rather than scanning for a colon to decide. Almost every
  // address a Worker sees is IPv4, and a pre-scan reads the whole string an
  // extra time before parsing has begun — measured at two thirds of the total
  // lookup cost, more than the search it precedes. IPv6 input fails this in a
  // few characters, so the fallback is cheap.
  const v = parseIPv4(s, 0, n);
  if (v >= 0) {
    out[0] = v;
    return FAMILY_V4;
  }
  if (s.charCodeAt(0) !== CH_COLON && indexOfColon(s, n) < 0) return FAMILY_NONE;

  let count = 0; // groups written to `parsed`, in source order
  let gapAt = -1; // where the "::" run sits among them, -1 if absent
  let i = 0;

  if (s.charCodeAt(0) === CH_COLON) {
    if (n < 2 || s.charCodeAt(1) !== CH_COLON) return FAMILY_NONE;
    gapAt = 0;
    i = 2;
  }

  while (i < n) {
    const groupStart = i;
    let val = 0;
    let digits = 0;
    while (i < n) {
      const h = hexVal(s.charCodeAt(i));
      if (h < 0) break;
      val = (val << 4) | h;
      digits++;
      i++;
      if (digits > 4) return FAMILY_NONE;
    }

    if (i < n && s.charCodeAt(i) === CH_DOT) {
      // A trailing dotted quad occupies the final two groups.
      const v4 = parseIPv4(s, groupStart, n);
      if (v4 < 0) return FAMILY_NONE;
      if (count + 2 > 8) return FAMILY_NONE;
      parsed[count++] = (v4 >>> 16) & 0xffff;
      parsed[count++] = v4 & 0xffff;
      i = n;
      break;
    }

    if (digits === 0) return FAMILY_NONE;
    if (count >= 8) return FAMILY_NONE;
    parsed[count++] = val;

    if (i === n) break;
    if (s.charCodeAt(i) !== CH_COLON) return FAMILY_NONE;
    i++;

    if (i < n && s.charCodeAt(i) === CH_COLON) {
      if (gapAt >= 0) return FAMILY_NONE; // a second "::"
      gapAt = count;
      i++;
      if (i === n) break; // trailing "::"
    } else if (i === n) {
      return FAMILY_NONE; // trailing single colon, e.g. "1:2:"
    }
  }

  if (gapAt < 0) {
    if (count !== 8) return FAMILY_NONE;
    for (let k = 0; k < 8; k++) expanded[k] = parsed[k]!;
  } else {
    // The run must stand for at least one group, so 8 groups plus a "::" is
    // not an address even though it has the right number of parts.
    if (count > 7) return FAMILY_NONE;
    const zeros = 8 - count;
    for (let k = 0; k < gapAt; k++) expanded[k] = parsed[k]!;
    for (let k = 0; k < zeros; k++) expanded[gapAt + k] = 0;
    for (let k = gapAt; k < count; k++) expanded[k + zeros] = parsed[k]!;
  }

  // ::ffff:a.b.c.d — answer about the IPv4 address the caller means.
  if (
    expanded[0] === 0 &&
    expanded[1] === 0 &&
    expanded[2] === 0 &&
    expanded[3] === 0 &&
    expanded[4] === 0 &&
    expanded[5] === 0xffff
  ) {
    out[0] = ((expanded[6]! << 16) | expanded[7]!) >>> 0;
    return FAMILY_V4;
  }

  out[0] = ((expanded[0]! << 16) | expanded[1]!) >>> 0;
  out[1] = ((expanded[2]! << 16) | expanded[3]!) >>> 0;
  out[2] = ((expanded[4]! << 16) | expanded[5]!) >>> 0;
  out[3] = ((expanded[6]! << 16) | expanded[7]!) >>> 0;
  return FAMILY_V6;
}
