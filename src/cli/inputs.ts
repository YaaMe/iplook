import { basename } from "node:path";
import { InputError, type TableBuilder } from "../build/builder.js";
import type { ConflictPolicy } from "../build/sweep.js";
import { forEachLine } from "./read-lines.js";

const DEFAULT_STEM = /(?:^|_)([^_/\\]+)\.[^.]+$/;

export function conflictPolicy(raw: string | undefined): ConflictPolicy {
  if (raw === undefined) return "longest";
  if (raw === "longest" || raw === "last" || raw === "error") return raw;
  throw new InputError(
    `unknown conflict policy "${raw}": expected longest, error or last`,
  );
}

/** Keep build and verify's line parsing and value precedence identical. */
export async function readInputs(
  builder: TableBuilder,
  paths: readonly string[],
  opts: {
    value?: string | undefined;
    fromFilename?: boolean | undefined;
    pattern?: string | undefined;
    /** Fail on a file name the pattern does not match, before reading the file. */
    requireFilenameValue?: boolean | undefined;
  },
): Promise<number> {
  const fromName = opts.fromFilename
    ? opts.pattern
      ? new RegExp(opts.pattern)
      : DEFAULT_STEM
    : undefined;
  const dec = new TextDecoder();
  let lines = 0;
  for (const path of paths) {
    let fileId = 0;
    if (fromName) {
      const m = fromName.exec(basename(path));
      if (m?.[1]) fileId = builder.valueId(m[1]);
      else if (opts.requireFilenameValue)
        throw new InputError(`no value in file name: ${path}`);
    } else if (opts.value) {
      fileId = builder.valueId(opts.value);
    }

    await forEachLine(path, (buf, start, end) => {
      let stop = end;
      for (let i = start; i < end; i++) {
        if (buf[i] === 35) {
          stop = i;
          break;
        }
      }
      while (stop > start && buf[stop - 1]! <= 32) stop--;
      let from = start;
      while (from < stop && buf[from]! <= 32) from++;
      if (from >= stop) return;

      const line = dec.decode(buf.subarray(from, stop));
      const sep = line.search(/[\s,;]/);
      const block = sep < 0 ? line : line.slice(0, sep);
      const inline = sep < 0 ? "" : line.slice(sep + 1).trim();
      const id = inline !== "" ? builder.valueId(inline) : fileId;
      if (id === 0) {
        if (fromName)
          throw new InputError(`no value in file name for "${block}": ${path}`);
        throw new InputError(
          `${path}: no value for "${block}" — pass --value or --value-from-filename`,
        );
      }
      builder.addPrefixId(block, id);
      lines++;
    });
  }
  return lines;
}
