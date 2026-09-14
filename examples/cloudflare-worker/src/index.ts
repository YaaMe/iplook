import { IpTable } from "iplook";
import table from "./geo.iplk";

/**
 * Built once per isolate, not once per request.
 *
 * Module scope runs when the isolate starts, and isolates are reused across
 * requests, so the ~1 ms of validation and index building is amortised over
 * everything that isolate serves. Doing this inside `fetch` would pay it every
 * time.
 *
 * Note this is I/O-free. Workers forbid I/O at module scope, which is exactly
 * why the table is imported rather than fetched: there is nothing to await.
 */
const geo = new IpTable(table);

export default {
  fetch(req: Request): Response {
    // CF-Connecting-IP is the client address. It can be IPv6, and can arrive
    // in the ::ffff: form, which iplook unmaps to the v4 table for you.
    const ip = req.headers.get("CF-Connecting-IP") ?? "";
    const country = geo.lookup(ip);

    // undefined means two different things — the address is in no block, or it
    // was not an address at all. Both are "we do not know", so both get ZZ,
    // the ISO code reserved for exactly that.
    return Response.json({
      ip,
      country: country ?? "ZZ",
      // What this isolate is carrying, so the cost is visible rather than
      // assumed. `bytes` is the table; `indexBytes` is heap the index takes
      // and the bundle does not.
      table: geo.size,
    });
  },
} satisfies ExportedHandler;
