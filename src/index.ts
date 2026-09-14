/**
 * iplook — map an IP address to a value, for a table that is fixed once built.
 *
 * This entry point is the reader only. It must stay free of the builder and of
 * any Node API: a Worker importing it should get the search and nothing else.
 * See `iplook/text` to build a small table at startup from CIDR text, and
 * `iplook/build` for the offline builder.
 */

export { FormatError, NO_VALUE } from "./format.js";
export { IpTable, type LoadOptions } from "./table.js";
