/**
 * iplook/text — build a table at startup from CIDR text.
 *
 * For the caller whose table is small enough that a build step is not worth
 * it: a few thousand allowlist entries bundled as a text file and turned into
 * a table once per isolate.
 *
 * This shares the offline builder rather than reimplementing a smaller one.
 * The plan was to write a separate lightweight path, but two implementations
 * of the same semantics are two truths, and the cost of keeping them agreeing
 * is higher than the few kilobytes the shared builder brings in. A caller who
 * wants only the reader imports `iplook`, which references none of this.
 *
 * The ceiling is the bundle, not the CPU: a million CIDR lines is ~16 MB of
 * text and will not fit a Worker script long before the build time matters.
 */

import { TableBuilder } from "./build/builder.js";
import { IpTable, type LoadOptions } from "./table.js";

export interface FromTextOptions extends LoadOptions {
  /** Value for lines carrying none. Defaults to "in", so a bare list is a set. */
  value?: string;
  /** Separator between block and value on a line. Default: comma or whitespace. */
  onConflict?: "longest" | "error" | "last";
  /** Warn above this many lines. Default 200000; set 0 to silence. */
  warnAbove?: number;
}

const LINE = /\r?\n/;
const SEP = /[\s,;]+/;

/**
 * Build a table from lines of CIDR.
 *
 * Each non-empty, non-`#` line is a block, optionally followed by a value:
 *
 *     10.0.0.0/8
 *     192.168.0.0/16,office
 *     1.2.3.4            # a bare address is a host route
 */
export function fromText(text: string, opts: FromTextOptions = {}): IpTable {
  const defaultValue = opts.value ?? "in";
  const warnAbove = opts.warnAbove ?? 200_000;

  const builder = new TableBuilder(
    opts.onConflict ? { onConflict: opts.onConflict } : {},
  );

  // Interned on first use, not up front: a file whose every line carries its
  // own value should not end up with an unused entry in the dictionary, since
  // that shifts every id and makes two tables over the same data differ.
  let defaultId = 0;
  const getDefaultId = (): number => {
    if (defaultId === 0) defaultId = builder.valueId(defaultValue);
    return defaultId;
  };

  const lines = text.split(LINE);
  if (warnAbove > 0 && lines.length > warnAbove) {
    console.warn(
      `iplook: building ${lines.length} lines at startup. Above roughly ${warnAbove} ` +
        "lines, build the table ahead of time with `npx iplook build` and ship the " +
        "result — the text itself will outgrow the script size limit first.",
    );
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const hash = raw.indexOf("#");
    const line = (hash < 0 ? raw : raw.slice(0, hash)).trim();
    if (line === "") continue;

    const parts = line.split(SEP);
    const block = parts[0]!;
    const value = parts.length > 1 && parts[1] !== "" ? parts[1]! : undefined;
    builder.addPrefixId(
      block,
      value === undefined ? getDefaultId() : builder.valueId(value),
    );
  }

  return new IpTable(builder.build().buffer, opts);
}
