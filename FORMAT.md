# The `.iplk` format

Version 1.

This is the normative description, written so a reader can be implemented in
another language without consulting the TypeScript. The implementation in
`src/format.ts` is the only place in this repository that encodes these
offsets; everywhere else goes through it.

All integers are **little-endian**, unconditionally. A `Uint32Array` view over
a buffer is native-endian, so little-endian is what allows a zero-copy view on
every platform JavaScript runs on; a big-endian reader must byte-swap on load.

## The thing being stored

A **complete partition** of an address space: an ascending list of span starts,
each with a value id. The first start is always zero, starts strictly increase,
and a span runs until the next one begins. The last span runs to the top of the
space.

There is no "not found". An address not covered by the source data falls in a
span whose value id is 0, which decodes to the empty string. That is what lets
a sparse input and a dense one read through the same code path.

A reader **must** verify on load that `starts[0] == 0` and that starts strictly
increase. Both properties are what every lookup relies on, and a file violating
either answers wrongly for the rest of its life without erroring.

## Header — 64 bytes

| off | size | field | |
|---|---|---|---|
| 0 | 4 | magic | `IPLK`, i.e. `0x4b4c5049` little-endian |
| 4 | 1 | formatVersion | what wrote the file |
| 5 | 1 | minReaderVersion | refuse the file if this exceeds your version |
| 6 | 1 | flags | bit 0 `hasV4`, bit 1 `hasV6` |
| 7 | 1 | v6Stride | u32 words per IPv6 boundary, 1–4; 0 when no IPv6 |
| 8 | 1 | valueWidth | bytes per value id: 1, 2 or 4 |
| 9 | 1 | encoding | 0 = raw. No other value is defined |
| 10 | 2 | reserved | zero |
| 12 | 4 | headerLength | 64 in version 1 |
| 16 | 4 | v4Count | spans |
| 20 | 4 | v4StartsOffset | |
| 24 | 4 | v4ValuesOffset | |
| 28 | 4 | v6Count | spans |
| 32 | 4 | v6StartsOffset | |
| 36 | 4 | v6ValuesOffset | |
| 40 | 4 | dictCount | including the reserved empty value |
| 44 | 4 | dictIndexOffset | |
| 48 | 4 | dictBytesOffset | |
| 52 | 4 | dictBytesLength | |
| 56 | 4 | metaOffset | 0 when absent |
| 60 | 4 | metaLength | |

Every section is found by its **absolute offset**, never by assuming it follows
another, and every section begins on an **8-byte boundary**. Both rules exist
so a reader can take typed-array views directly and so a later version can add
a section without moving the existing ones.

Offsets are relative to the start of the table, and a reader **must** check,
before viewing any of them, that `offset + size` falls within the bytes it was
actually handed — not within whatever buffer those bytes happen to live in. A
truncated table has to be refused: a reader that views past the end answers out
of unrelated memory and never says so. Trailing padding after the last section
is not required, so the bound is the end of the last section, not the end of
the file.

### Versioning

`minReaderVersion` is the whole compatibility mechanism.

A writer that only *adds* sections leaves it at 1. An older reader finds
everything it knows by absolute offset and ignores the rest, so it stays
correct. A writer that changes what an existing section *means* must raise it,
and older readers refuse the file with a clear message rather than
misinterpreting it.

## Sections

### Starts

`v4Count` u32 values at `v4StartsOffset`, ascending, the first being 0.

`v6Count × v6Stride` u32 values at `v6StartsOffset`. Each boundary is
`v6Stride` words, most significant first, and the words are **interleaved** —
boundary *i* occupies `[i × stride, (i+1) × stride)`. A binary search reads a
whole boundary from one place; parallel arrays would cost a cache miss per word
on every probe.

`v6Stride` is the number of leading words needed to tell every boundary apart:
the trailing words that are zero in *every* boundary are not stored. A corpus
whose boundaries are all /64-aligned needs two words; one boundary with bits
below that forces four for the whole table. A writer **must not** round
boundaries to reduce the stride, because that changes which addresses map to
which value.

Comparison is word by word from the most significant.

### Values

`v4Count` (resp. `v6Count`) unsigned integers of `valueWidth` bytes, one per
span, at the corresponding offset. The id indexes the dictionary.

`valueWidth` is the narrowest that fits `dictCount`: 1 for up to 256 values,
2 for up to 65536, 4 above. Country codes fit a byte; ASNs do not.

### Dictionary

At `dictIndexOffset`, `dictCount + 1` u32 byte offsets into the blob at
`dictBytesOffset`. Entry *i* is `blob[index[i] .. index[i+1])`, UTF-8.

**Index 0 is reserved and is the empty string.** It is the "no value" id.

Ids are assigned in **sorted order of the value string**. This makes the output
byte-identical regardless of the order the inputs were read in, which matters
for an artefact people commit and diff.

### Metadata

`metaLength` bytes of UTF-8 JSON at `metaOffset`, an object, or absent when
`metaOffset` is 0. A reader that does not understand it ignores it. Nothing in
the lookup path may depend on it.

## Looking up

1. Parse the address. An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) should be
   unmapped and answered from the IPv4 table.
2. Find the last span whose start is at or below the address.
3. Read that span's value id, and the dictionary entry for it.

A complete partition makes step 2 total: there is always such a span, and no
fallback is needed.

An implementation is free to build an index at load to narrow step 2 — this one
brackets the search with a 65537-entry table over the top 16 bits — but no such
index is part of the format. It is derived state, and a reader that does not
build one still answers identically.
