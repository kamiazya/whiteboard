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
 *
 * Two spellings of "its own host" count: a `makeHost` factory, and a
 * component named `Host` that renders `<SpatialEditor` over a `useState`.
 * Guarding only the first let the second grow to fifty-odd copies, because a
 * test that wrote `function Host()` directly never looked like the thing the
 * rule was about.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')
const WEB_SRC = join(REPO_ROOT, 'apps/web/src')
const EDITOR_DIR = join(WEB_SRC, 'components/spatial-editor')
const HOST_MODULE = join(REPO_ROOT, 'apps/web/src/test-utils/spatial-editor-host.tsx')

const LOCAL_HOST = /^(?:async\s+)?(?:function|const)\s+makeHost\b/m
const LOCAL_ROOT_OF = /^(?:export\s+)?(?:function|const)\s+rootOf\b/m
const SHARED_HOST_CALL = /\bmakeEditorHost\s*\(/
const HOST_COMPONENT = /^[ \t]*(?:export\s+)?(?:function|const)\s+Host\b/m
const RENDERS_EDITOR = /<SpatialEditor\b/
const OWNS_STATE = /\buseState\b/
const IMPORTS_SHARED_HOST = /\bmakeEditorHost\b/

/** A `makeHost` factory, or a `Host` component over `<SpatialEditor` that owns canvas state. */
function definesOwnHost(source: string): boolean {
  if (LOCAL_HOST.test(source)) return true
  return HOST_COMPONENT.test(source) && RENDERS_EDITOR.test(source) && OWNS_STATE.test(source)
}

/**
 * Files, relative to apps/web/src, that keep a host of their own, and why the
 * shared one cannot serve them.
 */
const OWN_HOST: Readonly<Record<string, string>> = {
  'components/spatial-editor/canvas-settings.browser.test.tsx':
    'mounts the display-settings inspector, not the editor — there is no SpatialEditor in it',
  'components/spatial-editor/edge-routing-menu.browser.test.tsx':
    'a sibling display-settings panel shares the one canvas state with the editor inside the same frame',
  'components/spatial-editor/dialog-target-vanishes.browser.test.tsx':
    'removes a node from outside the editor and bumps externalVersion, which the shared host does not expose',
  'components/spatial-editor/clipboard.browser.test.tsx':
    'replaces the whole canvas from outside through latest.reset, without an externalVersion bump',
  'components/spatial-editor/selection-survives-external-delete.browser.test.tsx':
    'removes a node from outside the editor and bumps externalVersion, which the shared host does not expose',
  'components/spatial-editor/keyboard-avoidance.browser.test.tsx':
    'rerenders the one mounted Host with a new height to resize the frame while the canvas state lives on; the shared host fixes its frame when it is made',
  'components/spatial-editor/worker-scene-responsiveness.browser.test.tsx':
    'a button beside the editor replaces the canvas from outside, so the canvas state is shared with something other than the editor',
  'components/document-editor/canvas-verb-bar.browser.test.tsx':
    'the frame also holds a sibling CanvasVerbBar, positioned against the same box as the editor',
}

function editorTests(): string[] {
  return readdirSync(EDITOR_DIR)
    .filter((name) => name.endsWith('.browser.test.tsx'))
    .sort()
}

const read = (name: string) => readFileSync(join(EDITOR_DIR, name), 'utf-8')

/** Every `*.test.tsx` under apps/web/src, as a path relative to it. */
function webTests(dir: string = WEB_SRC): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : webTests(path)
      return entry.name.endsWith('.test.tsx') ? [relative(WEB_SRC, path).split(sep).join('/')] : []
    })
    .sort()
}

const readWeb = (path: string) => readFileSync(join(WEB_SRC, path), 'utf-8')

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

  it('recognises a hand-written Host component in each spelling (self-test)', () => {
    const body = (head: string) =>
      `${head} {\n  const [canvas, setCanvas] = useState(start)\n  return <SpatialEditor canvas={canvas} onChange={setCanvas} />\n}`
    expect(definesOwnHost(body('function Host()'))).toBe(true)
    expect(definesOwnHost(body('export function Host({ tool }: Props)'))).toBe(true)
    expect(definesOwnHost(body('  function Host()'))).toBe(true)
    expect(definesOwnHost(body('const Host = () =>'))).toBe(true)
    expect(definesOwnHost(body('export const Host = () =>'))).toBe(true)
    // A Host that is not an editor harness, or holds no canvas state, is not the shape.
    expect(
      definesOwnHost('function Host() {\n  const [n] = useState(0)\n  return <Panel />\n}'),
    ).toBe(false)
    expect(definesOwnHost('function Host() {\n  return <SpatialEditor canvas={c} />\n}')).toBe(
      false,
    )
    expect(definesOwnHost('const { Host } = makeEditorHost({ initial })')).toBe(false)
    expect(
      definesOwnHost('function HostFrame() {\n  useState()\n  return <SpatialEditor />\n}'),
    ).toBe(false)
  })

  it('has no file defining its own editor host outside the allowlist', () => {
    const offenders = webTests()
      .filter(
        (path) =>
          !(path in OWN_HOST) &&
          !IMPORTS_SHARED_HOST.test(readWeb(path)) &&
          definesOwnHost(readWeb(path)),
      )
      .map(
        (path) =>
          `${path}: defines its own editor host — use makeEditorHost from test-utils/spatial-editor-host.tsx, or allowlist it here with the reason it cannot`,
      )
    expect(offenders).toEqual([])
  })

  it('lists only files that still define their own editor host', () => {
    const stale = Object.keys(OWN_HOST).filter((path) => {
      const full = join(WEB_SRC, path)
      return !existsSync(full) || !definesOwnHost(readWeb(path))
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
    expect(callers.length).toBeGreaterThanOrEqual(90)
    // The widened scan walks all of apps/web/src, not only this directory.
    expect(webTests().length).toBeGreaterThan(300)
    expect(webTests()).toContain('components/document-editor/canvas-verb-bar.browser.test.tsx')
  })
})
