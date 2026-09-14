# iplook on Cloudflare Workers

A deployable Worker that answers "which country is this address in" from a
table bundled into the script.

```sh
npm install
npm run dev        # builds the table, then starts wrangler
```

```sh
curl 'http://localhost:8787' -H 'CF-Connecting-IP: 203.0.113.7'
# {"ip":"203.0.113.7","country":"JP","table":{...}}
```

`npm run deploy` does the same and ships it.

## What the pieces do

**`cidr/*.txt`** — one file per value, the file name being the value. This is
the shape a purchased database usually reduces to, and what
`--value-from-filename` expects. Three tiny files here; a real one is millions
of lines.

**`npm run table`** turns them into `src/geo.iplk`. It runs before `dev` and
`deploy`, so the table is always current with the input. Committing the `.iplk`
instead is also reasonable — then the build is reproducible without the source
data, which matters when the source is licensed and cannot be checked in.

**`wrangler.jsonc`** carries the one line that makes this work:

```jsonc
"rules": [{ "type": "Data", "globs": ["**/*.iplk"], "fallthrough": true }]
```

Without it the import fails. With it, `import table from "./geo.iplk"` is an
`ArrayBuffer` in the module graph — no fetch, and none of the 33% a base64
string would add.

**`src/index.ts`** builds the table at module scope. Isolates are reused across
requests, so that happens once per isolate rather than once per request. It is
also I/O-free, which it has to be: Workers forbid I/O at module scope.

## Size

The table is what you make it. A whole-world country table measures 1.49 MB,
which compresses to 0.61 MB — inside the Free plan's 3 MB script limit with
most of it still free. Check yours with `iplook inspect src/geo.iplk`.

If your table is too large to bundle, or you want to replace it without
redeploying, fetch it from R2 instead — but the promise has to be memoised,
and a rejection must not be:

```ts
let pending: Promise<IpTable> | undefined;

function getTable(env: Env): Promise<IpTable> {
  return (pending ??= env.BUCKET.get("geo.iplk")
    .then(async (o) => new IpTable(await o!.arrayBuffer()))
    .catch((e) => {
      pending = undefined;   // caching a rejection bricks the isolate
      throw e;
    }));
}
```

Memoising the promise rather than the result is what stops a burst of requests
on a cold isolate from fetching the table several times over.
