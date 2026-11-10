/**
 * The TypeScript JSON Canvas reader (`readJsonCanvasText`) exists for one realm:
 * the MCP Apps widget iframe and the viewer sharing its code, which have no Rust
 * core to read through. The daemon and the web app answer JSON Canvas only
 * through the core (`parseSpatial`, `serializeSpatial`), and keeping this reader
 * out of their source is what stops a failure to install the core from turning
 * into a silent fallback to a second implementation.
 *
 * So no shipped file outside `packages/codec` and `packages/canvas-viewer` may
 * use it. `apps/web` reaches a read it needs through `canvas-viewer`'s
 * `parseViewerScene`, which is the viewer's own and says so.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { countNamedUses } from './named-use-scan.js'
import { isExcludedPath, REPO_ROOT, relativeToRepo, SCAN_ROOTS } from './scan-roots.js'
import { isShippedPath, walkSourceFiles } from './source-scan.js'

const READER = 'readJsonCanvasText'
const READER_MODULE = 'read-json-canvas-text'
const OWNERS = ['packages/codec/src/', 'packages/canvas-viewer/src/']

const shipped = SCAN_ROOTS.flatMap((root) => walkSourceFiles(join(REPO_ROOT, root)))
  .filter((path) => !isExcludedPath(path) && isShippedPath(path))
  .map((path) => ({ path: relativeToRepo(path), source: readFileSync(path, 'utf8') }))

describe('the TypeScript JSON Canvas reader stays in the viewer realm', () => {
  it('finds the source it judges, and the one caller that is allowed to have it', () => {
    expect(shipped.length).toBeGreaterThan(1500)
    const users = shipped.filter((f) => countNamedUses(f.path, f.source, [READER]) > 0)
    expect(users.map((f) => f.path)).toEqual(['packages/canvas-viewer/src/scene.ts'])
  })

  it('is used by no daemon, server-core or web source, and its module is imported by none', () => {
    const outside = shipped.filter((f) => !OWNERS.some((owner) => f.path.startsWith(owner)))
    expect(outside.length).toBeGreaterThan(1000)
    const offenders = outside
      .filter(
        (f) => countNamedUses(f.path, f.source, [READER]) > 0 || f.source.includes(READER_MODULE),
      )
      .map((f) => f.path)
    expect(offenders).toEqual([])
  })
})
