/**
 * How the production build is cut into chunks (rolldown's `codeSplitting`).
 *
 * Extracted from `vite.config.ts` so `vite-code-splitting.test.ts` can assert
 * on the rule directly: what it decides is visible only in a production
 * bundle, which no test that runs against source builds.
 */
import type { Rolldown } from 'vite'

// A package by its own directory: `@floating-ui/react-dom` ends in
// `/react-dom/` too, and a substring match took it — and, with it, every
// floating-ui module it imports — into vendor-react, which every first paint
// modulepreloads though no first-paint screen positions a popover.
const REACT = /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/
const LUCIDE = /node_modules[\\/]lucide-react[\\/]/
const NODE_MODULES = /node_modules[\\/]/
// A captured `index.css` would be emitted as `shell-*.css`, and the
// bundle-size gate's CSS budget reads `index-*.css`; the HTML entry is the
// entry chunk itself.
const STAYS_WITH_ENTRY = /\.(?:css|html)(?:\?.*)?$/
const DYNAMIC_IMPORT = /\bimport\s*\(/
// A comment that mentions `import()` is not a call: zod 4.6.7 carries one, and
// matching it took every module that reaches zod off first paint. Only a
// whole-line `//` comment is dropped, so a `//` inside a string on the same
// line as a real call (a URL) never hides that call.
const COMMENTS = /\/\*[\s\S]*?\*\/|^[ \t]*\/\/.*$/gm

type ModuleGraph = Pick<Rolldown.ChunkingContext, 'getModuleInfo'>

/**
 * Answers whether nothing `id` statically reaches holds a dynamic import,
 * remembering answers across one build.
 *
 * Why it matters: it is what keeps the ENTRY chunk. The modules that reach a
 * dynamic import (main, boot, App and the screens that `lazy()` a page) are
 * left out of the first-paint groups, so they stay in `index-*.js` with
 * `index-*.css` beside it — the names the bundle-size gate's budgets key on.
 * Measured with this test dropped from `firstPaint`: the
 * entry module itself is captured, no `index-*` file is emitted at all, and
 * the gate fails both required budgets (the critical path falls to 5 files,
 * 130.7 KB gz, so a gate re-keyed on the HTML's entry script could take it).
 *
 * The call is matched in the source as well as read from
 * `dynamicallyImportedIds`, because a computed specifier (react-router's
 * route modules) never resolves to an id.
 */
function staticClosureIsSync(): (id: string, graph: ModuleGraph) => boolean {
  const clean = new Map<string, boolean>()
  const holdsDynamicImport = (info: Rolldown.ModuleInfo) =>
    info.dynamicallyImportedIds.length > 0 ||
    DYNAMIC_IMPORT.test((info.code ?? '').replace(COMMENTS, ''))
  /** Every module `id` statically reaches, or null once one holds a dynamic import. */
  const walk = (id: string, graph: ModuleGraph): Set<string> | null => {
    const visited = new Set<string>()
    const stack = [id]
    while (stack.length > 0) {
      const next = stack.pop() as string
      if (visited.has(next) || clean.get(next) === true) continue
      visited.add(next)
      const info = graph.getModuleInfo(next)
      if (info === null) continue
      if (clean.get(next) === false || holdsDynamicImport(info)) return null
      stack.push(...info.importedIds)
    }
    return visited
  }
  return (id, graph) => {
    const known = clean.get(id)
    if (known !== undefined) return known
    // A whole walk that meets no dynamic import proves every module it
    // visited clean too, since each one's closure is inside this one's. A walk
    // that does meet one proves only its start, so nothing else is recorded:
    // inside a cycle a module may have been visited before its own dirty
    // dependency was.
    const visited = walk(id, graph)
    if (visited === null) {
      clean.set(id, false)
      return false
    }
    for (const module of visited) clean.set(module, true)
    return true
  }
}

/** A fresh set of groups per build, since the closure answers are remembered. */
export function createCodeSplittingGroups(): Rolldown.CodeSplittingGroup[] {
  const isSync = staticClosureIsSync()
  const firstPaint = (name: string, vendor: boolean) => (id: string, graph: ModuleGraph) =>
    NODE_MODULES.test(id) === vendor && !STAYS_WITH_ENTRY.test(id) && isSync(id, graph)
      ? name
      : null
  // loro-crdt deliberately gets no group: only lazy pages import it, so it
  // already lands in a chunk they share, and a named group is a place for a
  // helper the entry needs to land beside the WASM bindings — which once put
  // all of loro on first paint.
  return [
    // React separated from app code so a deploy that touches only the app
    // leaves the (much larger) vendor chunk cached.
    { name: 'vendor-react', test: REACT, priority: 4 },
    // Icons get a chunk of their own. Left unassigned they merged into a
    // chunk carrying the Loro WASM's top-level await, and a build-time TLA
    // shim compiled that chunk's exports to `let`s assigned inside an async
    // body: `Copy` on the document kebab read `undefined`, and React threw
    // #130 to the error screen, minified only. The build now emits native
    // top-level await (smoke-bundle-size fails any `__tla` export), under
    // which an importer waits for the body instead of reading early.
    // ponytail: no longer load-bearing under native top-level await. Without
    // it the minified kebab renders its icons, and first paint is 8 files
    // and 124.9 KB gz against 9 and 132.8; dropping it re-pins this file's
    // test and the bundle-size gate's file budget.
    { name: 'vendor-icons', test: LUCIDE, priority: 3 },
    // The rest of first paint (`$initial`: an entry's static import chain),
    // as one vendor chunk and one app chunk. Rolldown turns its common-chunk
    // merging OFF for a build that holds a top-level await, which loro's WASM
    // does, so without these every module the entry shares with some lazy
    // page is a file of its own — 38 before first paint, each a
    // modulepreload request. What reaches a dynamic import stays out (see
    // staticClosureIsSync) and is chunked as before.
    { name: firstPaint('vendor-shell', true), tags: ['$initial'], priority: 2 },
    { name: firstPaint('shell', false), tags: ['$initial'], priority: 1 },
  ]
}
