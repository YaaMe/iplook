/**
 * iplook/build — the offline builder.
 *
 * Deliberately a separate entry point. A Worker importing `iplook` must not
 * drag the radix sort and the sweep into its bundle, and the only way to be
 * sure of that is for the reader never to reference this module.
 */

export {
  type BuilderOptions,
  type BuildStats,
  InputError,
  TableBuilder,
} from "./builder.js";
export { ConflictError, type ConflictPolicy } from "./sweep.js";
