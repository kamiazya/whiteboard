/**
 * How the production build is cut into chunks (rolldown's `codeSplitting`).
 *
 * Extracted from `vite.config.ts` so `vite-code-splitting.test.ts` can assert
 * on the rule directly: every hazard below is invisible in every test that
 * runs against source, and only appears in a minified production bundle.
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

type ModuleGraph = Pick<Rolldown.ChunkingContext, 'getModuleInfo'>

/**
 * Answers whether nothing `id` statically reaches holds a dynamic import,
 * remembering answers across one build.
 *
 * Why it matters: vite-plugin-top-level-await rewrites every chunk that holds
 * a dynamic import into an async body whose exports are `let`s assigned only
 * when that body runs. If the rewritten chunk also imports another rewritten
 * chunk, the body waits a microtask for it — and an importer the plugin did
 * NOT rewrite, evaluated in the same tick, reads those exports as
 * `undefined` (it awaits only for a top-level await, not a dynamic import).
 * A chunk that every lazy page imports must therefore never be rewritten,
 * which a group can only promise by capturing nothing that reaches an
 * `import()`. Captured together with the app's `lazy()` pages, the first
 * attempt at this grouping left the entry and a lazy canvas chunk calling
 * functions that were not assigned yet.
 *
 * The call is matched in the source as well as read from
 * `dynamicallyImportedIds`, because a computed specifier (react-router's
 * route modules) never resolves to an id and the plugin keys on the call.
 */
function staticClosureIsSync(): (id: string, graph: ModuleGraph) => boolean {
  const clean = new Map<string, boolean>()
  const holdsDynamicImport = (info: Rolldown.ModuleInfo) =>
    info.dynamicallyImportedIds.length > 0 || DYNAMIC_IMPORT.test(info.code ?? '')
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
  // already lands in a chunk they share. A named loro group once pulled
  // vite-plugin-top-level-await's shared dynamic-import helper in beside the
  // WASM bindings, and since the entry imports that helper for its own
  // `lazy()` calls, first paint loaded all of loro with it.
  return [
    // React separated from app code so a deploy that touches only the app
    // leaves the (much larger) vendor chunk cached.
    { name: 'vendor-react', test: REACT, priority: 4 },
    // Icons get a chunk of their own, and it is not cosmetic. Left
    // unassigned they are merged into whichever chunk imports them —
    // which for this app is one carrying the Loro WASM's TOP-LEVEL
    // AWAIT. Rolldown compiles such a chunk to `let Copy, Undo2, …`
    // declared at module scope and assigned inside the TLA body, so
    // every icon it exports reads `undefined` until that body runs.
    // A component rendering one then calls createElement(undefined)
    // and React throws #130 with no name in it. Measured on the
    // document kebab: `Copy` (the Duplicate row) was undefined and
    // took the whole page to the error screen — minified only, since
    // an unminified build lays the module out differently and hides
    // it entirely.
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
