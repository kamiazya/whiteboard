import { createRequire } from 'node:module'

/**
 * Dependencies whose `browser` export condition breaks inside a Worker,
 * pinned to their DOM-free builds.
 *
 * decode-named-character-reference (micromark's entity decoder, deep in the
 * remark graph) maps `browser` to a build that calls `document.createElement`
 * AT MODULE TOP LEVEL — so any worker chunk containing remark dies on
 * evaluation, dev and production alike. The package ships a `worker`
 * condition pointing at the DOM-free build, but Vite resolves `browser`
 * first even for worker chunks. `require.resolve` applies Node's own
 * conditions (no `browser`), which lands on exactly that build.
 *
 * Shared by vite.config.ts and vitest.browser.config.ts for the same reason
 * mcp-source-alias.ts is: two hand-kept copies drift, and the drifted copy
 * here would ship a production worker that throws before handling a message
 * while the test suite (running on the other copy) stays green.
 * mcp-source-alias-coverage.test.ts pins that both configs spread this map.
 */
export const workerSafeDepsAlias: Record<string, string> = {
  'decode-named-character-reference': createRequire(import.meta.url).resolve(
    'decode-named-character-reference',
  ),
}
