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
