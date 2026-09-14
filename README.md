# iplook

Map an IP address to a value, for a table that is fixed once built. Small
enough to bundle into a Cloudflare Worker.

```ts
import table from "./geo.iplk";
import { IpTable } from "iplook";

const geo = new IpTable(table);          // module scope: once per isolate

export default {
  fetch(req: Request): Response {
    const cc = geo.lookup(req.headers.get("CF-Connecting-IP") ?? "");
    return new Response(cc ?? "ZZ");
  },
};
```

```toml
# wrangler.toml — hands the file straight over as an ArrayBuffer,
# which avoids base64's 33% inflation
rules = [{ type = "Data", globs = ["**/*.iplk"] }]
```

## Why

A commercial IP database processed into CIDR is large. One real geolocation
corpus is **10,014,241 CIDR blocks** across 242 country codes — 160 MB of
text. Nothing in the JavaScript ecosystem answers questions about that inside
a Worker: `cidr-tools` and `ipaddr.js` scan linearly, so a single lookup over
a 126k-block list costs 20 ms and 1.8 ms respectively — the first alone
exceeds the Free plan's entire 10 ms CPU budget for a request.

But those ten million blocks are **312,379 spans** once adjacent blocks with
the same value are merged, and the result is an exact partition of IPv4: no
overlaps, no gaps, every address covered. That shape is much smaller than the
blocks that describe it, and it is smaller still to store, because a gapless
partition need not record where each span *ends* — the next one's start says
so.

| | |
|---|---|
| starts, `Uint32Array` | 1.19 MB |
| values, `Uint8Array` | 0.30 MB |
| **total** | **1.49 MB** |

Which fits the Free plan's 3 MB script limit, with no KV, no R2, and no
network on the request path.

The structure has to be proportional to the number of *boundaries*, not the
number of blocks. Anything storing one entry per CIDR — a trie node, a hash
bucket — is ten million entries for this data and does not fit.

## How it works

Take a three-block list in an 8-bit address space, so the numbers fit on a
line. The real thing is the same with 32 bits.

```
0/2    -> A      covers   0 .. 63
16/4   -> B      covers  16 .. 31     nested inside A
128/1  -> C      covers 128 .. 255
```

Address 20 is in both A and B. The more specific one wins, so the answer is B.

### 1. Flatten the nesting

Each block becomes two events, an entry and an exit, and a sweep goes left to
right holding an `active[]` array **indexed by prefix length**:

```
  at    event       active            winner (the longest)
   0    A enters    [2]=A             A
  16    B enters    [2]=A [4]=B       B     <- 4 is longer than 2
  32    B leaves    [2]=A             A
  64    A leaves    (empty)           none
 128    C enters    [1]=C             C
```

An array works instead of a priority queue because **two prefixes of the same
length can never both cover one address** — they are either the same block or
disjoint. So each length needs one slot, and the winner is the highest
occupied one, found with a single `Math.clz32`.

Cut wherever the winner changes:

```
start    0      16     32     64      128
value    A      B      A      none    C
         +------+------+------+--------+-->  255
```

The nesting is gone. Every address belongs to exactly one span.

Two details carry weight. **At a shared address, exits must be processed
before entries** — a block ending at X-1 and another of the same length
starting at X would otherwise have the arrival written into `active[len]` and
immediately cleared by the departure, losing a prefix silently. The radix sort
is chosen for its stability precisely to keep that order. And **gaps are spans
too**, carrying a reserved value id of 0, which is what makes a sparse
allowlist and a dense geolocation table the same shape with one read path.

### 2. Drop the ends

The line above has no gaps and no overlaps, so each span ends where the next
begins. Storing the start stores the end:

```js
starts = [0, 16, 32, 64, 128]   // Uint32Array, 4 bytes each
values = [A,  B,  A,  0,  C ]   // Uint8Array, 1 byte each
```

312,379 spans x 5 bytes is the 1.49 MB above.

### 3. Look up the last start at or below the address

Looking up 20: the last start at or below it is 16, at index 1, so the answer
is `values[1]` — B. Looking up 70: index 3, value 0, no answer. That is a
binary search, about nineteen comparisons over 312k spans.

### 4. Bracket it with a coarse index

At load, walk the spans once and record, for each bucket of the address's
leading bits, which span contains the bucket's first address:

```js
lo = idx[v >>> shift]
hi = idx[(v >>> shift) + 1]     // two or three comparisons, not nineteen
```

The bracket is **exact, not a hint**: because the partition is complete, an
address in bucket `b` is at or above the bucket's start, so its span is at or
after `idx[b]`; and below the next bucket's start, so at or before `idx[b+1]`.
No fallback path.

The index is sized to the table — about two spans a bucket, capped at 18 bits.
It costs heap and **zero bundle bytes**, and bundle bytes are the budget that
is actually tight. Each width measured in its own process, both orders, on the
312,379-span table:

| index | per bucket | search | parse + search | index heap | total heap |
|---|---|---|---|---|---|
| fixed 16 bits | 5.8 | 3.4 ns | 46.4 ns | 256 KB | 1.74 MB |
| sized to the table (18 here) | 2.2 | **2.8 ns** | **42.7 ns** | 1.00 MB | 2.49 MB |

A few percent at this size, for four times the index. The real gain is at the
other end, where a fixed width was absurd:

| spans | table | index, fixed | index, sized |
|---|---|---|---|
| 101 | 0 KB | 256 KB | **1 KB** |
| 1,001 | 5 KB | 256 KB | **2 KB** |
| 10,001 | 49 KB | 256 KB | **32 KB** |
| 65,536 | 320 KB | 256 KB | 256 KB |
| 312,380 | 1.49 MB | 256 KB | 1.00 MB |

A hundred-span allowlist used to carry an index 256 times its own size.

### 5. Load without parsing

The bytes in the file are the bytes in memory, so loading is taking views:

```js
new Uint32Array(buffer, offset, count)   // no copy, no parse, no walk
```

There is no hydration step, which is the point of the format.

### The chain

```
CIDR, nested
  |  sweep, cut where the winner changes
partition: no nesting, no gaps, no overlaps
  |  gapless => the end is implied
two parallel arrays
  |  arrays are bytes => nothing to parse
views + coarse index
  |
two or three comparisons
```

Each step is the direct consequence of the one above. So are the costs:
merging discards which prefixes formed a span, so there is **no delete**; and
the speed comes from precomputing over the whole corpus, so an insert means a
rebuild.

## Install

```sh
npm i iplook
```

## Building a table

Point it at what your pipeline already produces. Per-country files, value
taken from the file name:

```sh
npx iplook build cidr/*.txt --value-from-filename -o src/geo.iplk
```

```
read      10,014,241 lines, 10,014,241 blocks
merge     312,379 spans (96.9% collapsed)
values    242
write     src/geo.iplk  1.49 MB  in 5.6s
```

That is a real run over a commercial database, not an extrapolation. The
resulting table compresses to **0.61 MB gzip, 0.49 MB brotli** — the Worker
script limit counts compressed bytes, so a whole-world country table leaves
the Free plan's 3 MB budget mostly empty.

Or one file with the value inline:

```sh
npx iplook build all.txt -o geo.iplk
#   203.0.113.0/24,JP
#   198.51.100.0/22,US
```

Then check the artefact against what went into it:

```sh
npx iplook verify geo.iplk --against cidr/*.txt
#   verify    10,014,241 blocks agree
```

Every block goes back through the table it produced. On the corpus above that
is ten million checks in 5.3 s.

`iplook inspect` reports the header, counts and size. `iplook lookup` answers
a single address without writing a Worker.

## Small tables: skip the build step

A few thousand allowlist entries are not worth a build step. Bundle the text
and build it once per isolate:

```ts
import list from "./allowlist.txt";
import { fromText } from "iplook/text";

const allow = fromText(list);            // "10.0.0.0/8" per line, "#" comments
allow.lookup("10.1.2.3");                // "in"
```

Separate entry point on purpose: importing `iplook` gets you the reader and
nothing else, so a Worker that only answers questions does not carry the
builder. The ceiling here is the bundle rather than the CPU — a million lines
is ~16 MB of text and will not fit a script long before the build time
matters.

## Loading from R2 or KV

Workers forbid I/O at module scope, so the table has to be fetched inside the
first request, and the *promise* memoised — otherwise a burst on a cold
isolate fetches it many times over:

```ts
let pending: Promise<IpTable> | undefined;

function getTable(env: Env): Promise<IpTable> {
  return (pending ??= env.R2.get("geo.iplk")
    .then(async (o) => new IpTable(await o!.arrayBuffer()))
    .catch((e) => {
      pending = undefined;    // never memoise a rejection: it bricks the isolate
      throw e;
    }));
}
```

For a 1.49 MB table, bundling is simpler and has no cold-start fetch. Reach
for this when the table is too large to bundle, or when you want to replace it
without redeploying.

## API

```ts
new IpTable(src: ArrayBuffer | ArrayBufferView, opts?: LoadOptions)

table.lookup(ip: string): string | undefined   // undefined: no value, or not an address
table.lookupId(ip: string): number             // 0 means no value
table.lookupV4(ip: number): number             // for a caller holding a parsed uint32
table.values: readonly string[]                // values[0] is "" — the absent value
table.size: { v4, v6, bytes }
```

`LoadOptions.index` (default true) builds the coarse index; `validate`
(default true) checks the partition invariants.

The constructor takes bytes, not a path, and does not care what the file is
called. `.iplk` is only what the wrangler glob matches — `.bin` works as well,
as does an R2 object, a KV value or a `fetch` response.

`::ffff:1.2.3.4` is unmapped and answered from the IPv4 table, because that is
the address the caller means. Cloudflare hands out that form in some
configurations.

## Numbers

> **These are local measurements, not a reproducible benchmark.** They come
> from a commercial geolocation database that cannot be redistributed, so the
> corpus is not in this repository and you cannot re-run exactly these numbers.
> `bench/synth.mjs` generates a corpus with the same shape — a complete
> partition, a few hundred unevenly distributed values, spans of widely varying
> width, re-encoded into CIDR — which is what the figures actually depend on:
>
> ```sh
> node bench/synth.mjs 312379 242 > /tmp/synthetic.txt
> node --expose-gc bench/compare-libs.mjs /tmp/synthetic.txt
> ```

Node 24, darwin/arm64. Median of ten samples with outliers rejected, rotating
probes, correctness checked before anything is timed. **The machine was under
load, so read the ratios and not the absolute figures** — they moved 1.5x
between a quiet session and a busy one while every ratio held.

### Against the JavaScript ecosystem

What you would otherwise `npm install`, measured in one process on the same
125,918-block corpus with the same probes, and checked to agree on every one
of them before any is timed. Each takes the address as a **string**, which is
the form a Worker has.

| | lookup | retained | build |
|---|---|---|---|
| **iplook** | **101 ns** | **0.09 MB** | 83 ms |
| [`longest-prefix-match`](https://www.npmjs.com/package/longest-prefix-match) | 974 ns | 26.66 MB | 211 ms |
| [`ipaddr.js`](https://github.com/whitequark/ipaddr.js) `subnetMatch` | 1,783,528 ns | 47.15 MB | 735 ms |
| [`cidr-tools`](https://www.npmjs.com/package/cidr-tools) `containsCidr` | 20,384,848 ns | — | 123 ms |

Figures for the other libraries are measured here rather than quoted from
their documentation, so the machine is not part of the comparison —
`longest-prefix-match` measures 974 ns against the 50,000 ns its README
reports, which is a difference in machines, not in the library.

The last two scan linearly and degrade with the corpus: `cidr-tools` is 1.8 ms
on a 12k-block list, 20 ms on this one, and 89 ms on a whole-world table. The
first of those already exceeds the Free plan's entire 10 ms CPU budget for a
request.

`bench/compare-libs.mjs` reproduces the table, and also carries two structures
that are not npm packages but are the obvious alternatives — a stride-8 ART
trie and bucketing by mask length — for anyone weighing the design rather than
the dependency.

**Parsing compresses the visible gap.** About 85 of iplook's 101 ns is turning
the string into a number, which every row above also pays. Given a pre-parsed
address, `lookupV4` is 15.9 ns.

### The index

| | ns/op |
|---|---|
| search, plain binary | 133.9 |
| search, coarse index | **58.9** |
| parse + search | 145.8 |

The coarse index is a `Uint32Array(65537)` built at load: **zero bundle bytes**,
256 KB of heap, about three comparisons instead of nineteen. It is exact
rather than a hint, because a complete partition guarantees the answer lies in
`[idx[b], idx[b+1]]`.

Parsing is 60% of what a Worker pays. `lookupV4` skips it when you already
hold a parsed address.

## Status

Both families are complete and tested.

IPv6 boundaries are stored at the width the data needs: a corpus whose every
boundary is /64-aligned holds two words per boundary rather than four, halving
that section. One boundary with bits below /64 widens the whole table — the
builder reports that rather than rounding to avoid it, since rounding would
change answers.

Correctness is checked against a linear-scan reference over every one of the
2^24 addresses in `10.0.0.0/8`, plus boundary differential tests, property
tests over generated corpora, and a check that the built `dist/index.js`
contains no Node API and none of the builder.

## Licence

MIT
