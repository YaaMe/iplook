import { defineConfig } from "tsup";

// Three entry points, deliberately separate bundles.
//
// A Worker importing "iplook" must not drag in the builder: the radix sort and
// the streaming line reader are build-time machinery and would be dead weight
// in every isolate. tsup emits one chunk per entry with no shared runtime, and
// test/no-node-apis.test.ts checks the result rather than trusting it.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    text: "src/text.ts",
    build: "src/build/index.ts",
  },
  format: ["esm"],
  target: "es2022",
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  treeshake: true,
});
