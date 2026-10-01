/**
 * A spatial-editor browser test mounts the editor through
 * `test-utils/spatial-editor-host.tsx`, and finds the editor surface through
 * `test-utils/spatial-editor-root.ts`, rather than defining either again.
 *
 * Fifty-eight files each carried their own `makeHost` and half of them their
 * own `rootOf`, and the comment that was meant to excuse it ("distinct
 * fixtures, not copies") was wrong: counted by the options they take, they
 * were one shape — a controlled canvas in a fixed frame, `onChange` feeding
 * the next canvas back, the commands recorded. A change to how the editor
 * mounts in tests had to be made once per file, and a file that missed it
 * kept testing the old mount.
 *
 * A rule with an allowlist rather than a burn-down: the files below differ
 * from that shape in a way the shared host cannot absorb without growing an
 * option only they use, and each says what. The list is guarded from both
 * sides — a file that no longer defines its own host must leave it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')
const EDITOR_DIR = join(REPO_ROOT, 'apps/web/src/components/spatial-editor')
const HOST_MODULE = join(REPO_ROOT, 'apps/web/src/test-utils/spatial-editor-host.tsx')

const LOCAL_HOST = /^(?:async\s+)?(?:function|const)\s+makeHost\b/m
const LOCAL_ROOT_OF = /^(?:export\s+)?(?:function|const)\s+rootOf\b/m
const SHARED_HOST_CALL = /\bmakeEditorHost\s*\(/

/** Files that keep a `makeHost` of their own, and why the shared one cannot serve them. */
const OWN_HOST: Readonly<Record<string, string>> = {
  'canvas-settings.browser.test.tsx':
    'mounts the display-settings inspector, not the editor — there is no SpatialEditor in it',
  'edge-routing-menu.browser.test.tsx':
    'a sibling display-settings panel shares the one canvas state with the editor inside the same frame',
  'dialog-target-vanishes.browser.test.tsx':
    'removes a node from outside the editor and bumps externalVersion, which the shared host does not expose',
  'clipboard.browser.test.tsx':
    'replaces the whole canvas from outside through latest.reset, without an externalVersion bump',
}

function editorTests(): string[] {
  return readdirSync(EDITOR_DIR)
    .filter((name) => name.endsWith('.browser.test.tsx'))
    .sort()
}

const read = (name: string) => readFileSync(join(EDITOR_DIR, name), 'utf-8')

describe('spatial-editor browser tests share one host', () => {
  it('matches each shape (self-test)', () => {
    expect(LOCAL_HOST.test('function makeHost() {')).toBe(true)
    expect(LOCAL_HOST.test('function makeHost(initial: SpatialCanvas = start) {')).toBe(true)
    expect(LOCAL_HOST.test('const makeHost = () => {')).toBe(true)
    expect(LOCAL_HOST.test('  const { Host } = makeEditorHost({ initial })')).toBe(false)
    expect(LOCAL_ROOT_OF.test("const rootOf = (c: HTMLElement) =>\n  c.querySelector('x')")).toBe(
      true,
    )
    expect(
      LOCAL_ROOT_OF.test("import { rootOf } from '../../test-utils/spatial-editor-root.js'"),
    ).toBe(false)
    expect(SHARED_HOST_CALL.test('makeEditorHost({ initial })')).toBe(true)
  })

  it('has no file defining a makeHost outside the allowlist', () => {
    const offenders = editorTests()
      .filter((name) => !(name in OWN_HOST) && LOCAL_HOST.test(read(name)))
      .map(
        (name) =>
          `${name}: defines its own makeHost — use makeEditorHost from test-utils/spatial-editor-host.tsx, or allowlist it here with the reason it cannot`,
      )
    expect(offenders).toEqual([])
  })

  it('lists only files that still define their own makeHost', () => {
    const stale = Object.keys(OWN_HOST).filter((name) => {
      const path = join(EDITOR_DIR, name)
      return !existsSync(path) || !LOCAL_HOST.test(read(name))
    })
    expect(stale).toEqual([])
  })

  it('has no file defining its own rootOf', () => {
    const offenders = editorTests()
      .filter((name) => LOCAL_ROOT_OF.test(read(name)))
      .map(
        (name) =>
          `${name}: defines its own rootOf — import it from test-utils/spatial-editor-root.ts`,
      )
    expect(offenders).toEqual([])
  })

  it('reaches the population it governs', () => {
    // A scan that stopped matching reports a clean tree, which is exactly
    // what a passing run looks like — so the callers are counted too.
    const files = editorTests()
    expect(files.length).toBeGreaterThan(100)
    expect(existsSync(HOST_MODULE)).toBe(true)
    expect(readFileSync(HOST_MODULE, 'utf-8')).toMatch(/export function makeEditorHost\b/)
    const callers = files.filter((name) => SHARED_HOST_CALL.test(read(name)))
    expect(callers.length).toBeGreaterThanOrEqual(45)
  })
})
