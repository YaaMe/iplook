import { readHeader } from "../format.js";
import { IpTable } from "../table.js";

interface Spans {
  count: number;
  stride: number;
  word: (index: number, word: number) => number;
  value: (index: number) => string | undefined;
}

function spans(bytes: Uint8Array, table: IpTable, v6: boolean): Spans {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const h = readHeader(view);
  const count = v6 ? h.v6Count : h.v4Count;
  const stride = v6 ? h.v6Stride : 1;
  const startsOffset = v6 ? h.v6StartsOffset : h.v4StartsOffset;
  const valuesOffset = v6 ? h.v6ValuesOffset : h.v4ValuesOffset;
  return {
    // A missing family represents one absent span covering its entire space.
    count: Math.max(1, count),
    stride,
    word: (index, word) =>
      count === 0 || word >= stride
        ? 0
        : view.getUint32(startsOffset + (index * stride + word) * 4, true),
    value: (index) => {
      if (count === 0) return undefined;
      const offset = valuesOffset + index * h.valueWidth;
      const id =
        h.valueWidth === 1
          ? view.getUint8(offset)
          : h.valueWidth === 2
            ? view.getUint16(offset, true)
            : view.getUint32(offset, true);
      return id === 0 ? undefined : table.values[id];
    },
  };
}

/** Compare every interval in the union of both tables' boundaries, including gaps. */
export function compareTables(
  actual: Uint8Array,
  expected: Uint8Array,
  report: (address: string, got: string | undefined, want: string | undefined) => void,
): number {
  // Validate before reading the raw sections; comparison does not need indexes.
  const actualTable = new IpTable(actual, { index: false });
  const expectedTable = new IpTable(expected, { index: false });
  let bad = 0;
  for (const v6 of [false, true]) {
    const a = spans(actual, actualTable, v6);
    const b = spans(expected, expectedTable, v6);
    let ai = 0;
    let bi = 0;
    let boundary = a;
    let boundaryIndex = 0;

    for (;;) {
      const got = a.value(ai);
      const want = b.value(bi);
      if (got !== want) {
        if (bad < 10) report(formatAddress(boundary, boundaryIndex, v6), got, want);
        bad++;
      }

      if (ai + 1 === a.count && bi + 1 === b.count) break;
      let cmp = 0;
      if (ai + 1 === a.count) cmp = 1;
      else if (bi + 1 === b.count) cmp = -1;
      else {
        for (let k = 0; k < Math.max(a.stride, b.stride) && cmp === 0; k++) {
          cmp = a.word(ai + 1, k) - b.word(bi + 1, k);
        }
      }
      if (cmp <= 0) {
        boundary = a;
        boundaryIndex = ++ai;
      }
      if (cmp >= 0) {
        boundary = b;
        boundaryIndex = ++bi;
      }
    }
  }
  return bad;
}

function formatAddress(spans: Spans, index: number, v6: boolean): string {
  if (!v6) {
    const v = spans.word(index, 0);
    return [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join(".");
  }
  const groups: string[] = [];
  for (let k = 0; k < 4; k++) {
    const word = spans.word(index, k);
    groups.push((word >>> 16).toString(16), (word & 0xffff).toString(16));
  }
  return groups.join(":");
}
