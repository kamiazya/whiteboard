# Vendored BudouX (Apache-2.0)

`parser.ts` and `ja-model.ts` are copies of `budoux@0.9.0`'s
`module/parser.js` and `module/data/models/ja.js`. Both keep their original
license header; BudouX is Copyright 2021 Google LLC, Apache License 2.0.

## Why a copy and not a dependency

Taking the dependency **breaks the published package outright**. `budoux`'s
only public entry point is its root, which re-exports `HTMLProcessingParser`,
which imports `linkedom`, which pulls in the NATIVE `canvas` package. The
mcp-server bundle then fails at build time with
`Cannot find module '../build/Release/canvas.node'` — verified locally and in
CI's `packaged-smoke`, which passes on main and failed on the branch that
added the dependency.

Tree-shaking cannot save it: esbuild resolves the whole module graph before it
eliminates anything, so the native binding is reached while resolving, not
while bundling. Deep-importing `budoux/module/parser.js` is blocked by the
package's `exports` map (`ERR_PACKAGE_PATH_NOT_EXPORTED`).

The rest of the tail is the same story from the other side: for a text
segmenter, `budoux` declares `commander`, `google-artifactregistry-auth` and
`linkedom` as RUNTIME dependencies. `@kamiazya/whiteboard-mcp` is published to
npm, and a CLI argument parser plus a GCP auth library are not a supply chain
this package needs in order to find phrase boundaries.

What is actually valuable here is the trained MODEL — 24KB of weights. The
scoring loop around it is forty lines.

## Keeping it current

BudouX releases a new model when it retrains. To update, copy both files again
from the new release, keep the license headers, and re-run the equivalence
check that was used when this was vendored: construct both parsers and assert
identical `parse()` output over the text-wrapping corpus plus the edge cases
(`''`, a lone `a`, a lone `。`, punctuation-heavy prose, emoji, Latin/Japanese
mixed). That check lived in this directory and was deleted with the
dependency — a test importing a package the repo does not depend on is worse
than no test.

`parser.ts` differs from the original only in being typed and in having the
transpiler's `void 0` idioms written out. The algorithm is unchanged.
