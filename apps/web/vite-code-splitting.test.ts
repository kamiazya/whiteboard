/**
 * The chunk-splitting rule, asserted directly.
 *
 * This guard exists because what it pins is invisible to every other test in
 * this repo: the whole `web-browser` suite runs against source, and only a
 * production build is cut by these groups.
 */
import { describe, expect, it } from 'vitest'
import viteConfig from './vite.config.js'
import { createCodeSplittingGroups } from './vite-code-splitting.js'
import { pwaOptions } from './vite-pwa-options.js'

const STORE = '/repo/node_modules/.pnpm'
const LUCIDE = `${STORE}/lucide-react@1.28.0/node_modules/lucide-react/dist/esm/icons/copy.js`
const REACT = `${STORE}/react@19.0.0/node_modules/react/index.js`
const REACT_DOM = `${STORE}/react-dom@19.0.0/node_modules/react-dom/client.js`
const SCHEDULER = `${STORE}/scheduler@0.27.0/node_modules/scheduler/index.js`
const FLOATING = `${STORE}/@floating-ui+react-dom@2.1.9/node_modules/@floating-ui/react-dom/dist/floating-ui.react-dom.mjs`
const ZOD = `${STORE}/zod@4.4.3/node_modules/zod/v4/classic/schemas.js`
const ROUTER = `${STORE}/react-router@7.18.2/node_modules/react-router/dist/index.mjs`
const SRC = '/repo/apps/web/src'

interface Module {
  importedIds?: string[]
  dynamicallyImportedIds?: string[]
  code?: string
}

/** A build's view of the module graph, for the groups that walk it. */
function contextOver(graph: Record<string, Module>) {
  return {
    getModuleInfo: (id: string) => ({
      importedIds: graph[id]?.importedIds ?? [],
      dynamicallyImportedIds: graph[id]?.dynamicallyImportedIds ?? [],
      code: graph[id]?.code ?? '',
    }),
  }
}

/**
 * Rolldown's assignment, restated: the highest-priority group whose `test`
 * matches, whose `tags` the module carries and whose `name` answers takes it,
 * ties going to the earlier group. `initial` is the `$initial` tag — the
 * module is on an entry's static import chain. Pass `groups` to share one
 * build's state across calls.
 */
function chunkOf(
  id: string,
  initial: boolean,
  graph: Record<string, Module> = {},
  groups = createCodeSplittingGroups(),
): string | undefined {
  const ctx = contextOver(graph)
  const ordered = groups
    .map((group, index) => ({ group, index }))
    .sort((a, b) => (b.group.priority ?? 0) - (a.group.priority ?? 0) || a.index - b.index)
  for (const { group } of ordered) {
    if (group.tags?.includes('$initial') && !initial) continue
    const { test } = group
    if (test instanceof RegExp && !test.test(id)) continue
    if (typeof test === 'string' && !id.includes(test)) continue
    if (typeof test === 'function' && test(id) !== true) continue
    // The fake context carries only what the groups read.
    const name = typeof group.name === 'function' ? group.name(id, ctx as never) : group.name
    if (name) return name
  }
  return undefined
}

describe('createCodeSplittingGroups', () => {
  it('gives lucide-react a chunk of its own, away from the WASM top-level await', () => {
    // Why the group exists, and why it may go, is beside it in the module.
    expect(chunkOf(LUCIDE, true)).toBe('vendor-icons')
    expect(chunkOf(LUCIDE, false)).toBe('vendor-icons')
  })

  it('keeps react, react-dom and the scheduler in their own chunk', () => {
    for (const id of [REACT, REACT_DOM, SCHEDULER]) {
      expect(chunkOf(id, true)).toBe('vendor-react')
      expect(chunkOf(id, false)).toBe('vendor-react')
    }
  })

  it('leaves a package whose path merely contains react-dom out of vendor-react', () => {
    // radix's popper reaches `@floating-ui/react-dom`. Matched as a substring,
    // it took all of floating-ui into vendor-react, which every first paint
    // modulepreloads, though no first-paint screen positions a popover.
    expect(chunkOf(FLOATING, false)).toBeUndefined()
  })

  it('collects what first paint loads into one vendor chunk and one app chunk', () => {
    expect(chunkOf(ZOD, true)).toBe('vendor-shell')
    expect(chunkOf(`${SRC}/lib/subscribers.ts`, true)).toBe('shell')
  })

  it('leaves what first paint does not load to automatic chunking', () => {
    expect(chunkOf(ZOD, false)).toBeUndefined()
    expect(chunkOf(`${SRC}/lib/subscribers.ts`, false)).toBeUndefined()
  })

  it('leaves out a first-paint module that holds a dynamic import', () => {
    const app = `${SRC}/App.tsx`
    expect(
      chunkOf(app, true, { [app]: { dynamicallyImportedIds: [`${SRC}/pages/X.tsx`] } }),
    ).toBeUndefined()
    // A computed specifier never reaches dynamicallyImportedIds — react-router
    // loads route modules that way — so the call itself is what is matched.
    expect(
      chunkOf(ROUTER, true, { [ROUTER]: { code: 'await import(route.module)' } }),
    ).toBeUndefined()
  })

  it('leaves out a module whose static imports reach a dynamic import', () => {
    const lib = `${SRC}/lib/a.ts`
    const lazyHolder = `${SRC}/lib/b.ts`
    expect(
      chunkOf(lib, true, {
        [lib]: { importedIds: [lazyHolder] },
        [lazyHolder]: { code: "import('./x.js')" },
      }),
    ).toBeUndefined()
  })

  it('leaves out a module that reaches a dynamic import only through a cycle', () => {
    // b and c import each other and b also imports d, which holds the
    // import(). Walked from b, the walk meets b again inside c; recording c
    // as clean at that point would capture c, and with c its dependencies.
    const b = `${SRC}/lib/b.ts`
    const c = `${SRC}/lib/c.ts`
    const d = `${SRC}/lib/d.ts`
    // Both import orders, so whichever of c and d the walk reaches first,
    // one of them has c visited before the dirty d is found.
    for (const order of [
      [c, d],
      [d, c],
    ]) {
      const graph = {
        [b]: { importedIds: order },
        [c]: { importedIds: [b] },
        [d]: { code: "import('./x.js')" },
      }
      const oneBuild = createCodeSplittingGroups()
      expect(chunkOf(b, true, graph, oneBuild)).toBeUndefined()
      expect(chunkOf(c, true, graph, oneBuild)).toBeUndefined()
    }
  })

  it('leaves the stylesheet and the HTML entry with the entry chunk', () => {
    // Captured, `index.css` would be emitted as `shell-*.css`, and the
    // bundle-size gate's CSS budget reads `index-*.css`.
    expect(chunkOf(`${SRC}/index.css`, true)).toBeUndefined()
    expect(chunkOf('/repo/apps/web/index.html', true)).toBeUndefined()
  })
})

// Vite's own default (500 kB) warns on every build, because the svg
// renderer, the editor and mermaid are large LAZY chunks by design. A
// warning that always prints is one everybody skips, so a new one would
// land unread in the same tail.
const VITE_DEFAULT_LIMIT_KB = 500

describe('vite build chunkSizeWarningLimit', () => {
  it('is raised above the default so a healthy build prints no warning', () => {
    expect(viteConfig.build?.chunkSizeWarningLimit).toBeGreaterThan(VITE_DEFAULT_LIMIT_KB)
  })

  it('stays below the precache ceiling, so a chunk too big to precache still warns', () => {
    const precacheCeilingKb = (pwaOptions.workbox?.maximumFileSizeToCacheInBytes ?? 0) / 1000
    expect(precacheCeilingKb).toBeGreaterThan(0)
    expect(viteConfig.build?.chunkSizeWarningLimit).toBeLessThan(precacheCeilingKb)
  })
})
