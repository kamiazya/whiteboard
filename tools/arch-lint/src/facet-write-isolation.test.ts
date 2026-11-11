/**
 * The TypeScript facet write exists for the browser: the editor's derived form
 * and the facet picker judge a payload through the registry
 * (`validateFacetWrite`), and `firstUnrecognizedKey` is the rule it states for a
 * stripped key, because the web app keeps facet-engine's TypeScript. The daemon answers a facet write only through the
 * Rust core `server-core` installs, and keeping those two judgements out of
 * `server-core` and `mcp-server` is what stops a core that failed to install
 * from turning into a silent fallback to a second implementation.
 *
 * Reading a registry (`composeWorkspaceStencils`, `assetRefsOf`, `targetsOf`)
 * stays allowed: dressing a box with a stencil is a read, not a write.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { countNamedUses } from './named-use-scan.js'
import { isExcludedPath, REPO_ROOT, relativeToRepo, SCAN_ROOTS } from './scan-roots.js'
import { isShippedPath, walkSourceFiles } from './source-scan.js'

const JUDGEMENTS = ['validateFacetWrite', 'firstUnrecognizedKey']
const DAEMON_SIDE = ['packages/server-core/src/', 'packages/mcp-server/src/']

const shipped = SCAN_ROOTS.flatMap((root) => walkSourceFiles(join(REPO_ROOT, root)))
  .filter((path) => !isExcludedPath(path) && isShippedPath(path))
  .map((path) => ({ path: relativeToRepo(path), source: readFileSync(path, 'utf8') }))

const uses = (f: { path: string; source: string }): boolean =>
  countNamedUses(f.path, f.source, JUDGEMENTS) > 0

describe('the TypeScript facet write stays in the browser realm', () => {
  it('finds the source it judges, and the browser-side users that are allowed to have it', () => {
    expect(shipped.length).toBeGreaterThan(1500)
    const users = shipped.filter(uses).map((f) => f.path)
    expect(users).toEqual(
      expect.arrayContaining([
        'packages/facet-ui/src/plugin-ui.ts',
        'packages/facet-ui/src/derived-form.tsx',
      ]),
    )
    expect(users.length).toBeGreaterThanOrEqual(4)
  })

  it('is used by no server-core or mcp-server source', () => {
    const daemon = shipped.filter((f) => DAEMON_SIDE.some((root) => f.path.startsWith(root)))
    expect(daemon.length).toBeGreaterThan(250)
    expect(daemon.filter(uses).map((f) => f.path)).toEqual([])
  })
})
