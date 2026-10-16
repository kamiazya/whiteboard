// @vitest-environment node
/**
 * Every frame that mounts a document page also mounts `KeeperNotices`.
 *
 * A document page publishes what the keeper said about its writes — a
 * refusal, changes not landed yet — to stores, and the notices that read
 * those stores are mounted by the FRAME around the page, not by the page.
 * A frame that forgets them leaves a refused edit rolled back with nothing to
 * say why, and lets the tab close over changes the keeper never received;
 * every test of the page itself stays green over that.
 *
 * The pages are DERIVED, not listed: a page is a module that publishes its
 * connection state through `setShellConnection`, named after its file. A
 * hand-written list is what let the replica page — the one whose refused
 * offline edits the leave prompt exists for — go unchecked while it was the
 * third publisher.
 *
 * Checked per file: the frames are the modules that write a page's JSX, and
 * each has one shell it wraps every screen in. A page is recognised under its
 * own name, an import alias (`DaemonDocumentPage as Page`), or a `lazy()`
 * binding that resolves to it; comments are stripped, so a commented-out
 * `<KeeperNotices />` does not count as mounted.
 *
 * A page SWITCH is read as a page: `DaemonWorkspacePages` mounts the daemon's
 * pages for the frames that render it, and the notices belong to those
 * frames, which keep them outside the switch's error boundary. The module
 * defining a page or a switch is therefore not a frame itself.
 *
 * Blind spot: a page passed through a variable that is none of those (a
 * component map, a prop) is not seen as mounted.
 *
 * Sources come from Vite's `import.meta.glob` (raw text), so this needs no
 * `node:fs` — apps/web is browser-only.
 */
import { describe, expect, it } from 'vitest'
import { stripComments } from './test-utils/strip-comments.js'

const sourceModules = import.meta.glob('./**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>

const productionCode: ReadonlyMap<string, string> = new Map(
  Object.entries(sourceModules)
    .filter(
      ([path]) =>
        !path.includes('.test.') &&
        !path.includes('/test-utils/') &&
        !path.includes('/docs-snapshots/'),
    )
    .map(([path, source]) => [path, stripComments(source)] as const),
)

/** The store itself defines the publisher; it is not a page. */
const SHELL_STATUS_STORE = './lib/shell-status-store.ts'
const PUBLISHES_CONNECTION = /\bsetShellConnection\(/

/** A module path to the component it is named after: its file name, less the extension. */
function moduleName(path: string): string {
  return path.replace(/^.*\//, '').replace(/\.tsx?$/, '')
}

const publishers = [...productionCode]
  .filter(([path, code]) => path !== SHELL_STATUS_STORE && PUBLISHES_CONNECTION.test(code))
  .map(([path]) => path)
const PAGES = publishers.map(moduleName)

/** Module of each switch, so a renamed or deleted switch fails here rather than passing over nothing. */
const SWITCHES: Readonly<Record<string, string>> = {
  DaemonWorkspacePages: './pages/DaemonWorkspacePages.tsx',
}

/**
 * Modules that mount a page without being a frame, each with why. The guard
 * below holds every one to its reason: it must still mount a page, and every
 * path to it from the app's entry must pass through a page — whose own frame
 * this file already checks.
 */
const NOT_FRAMES: Readonly<Record<string, string>> = {
  './pages/daemon-terminal-screens.tsx':
    "the membership-refused render, drawn by DaemonDocumentPage in place of its body, so it sits inside that page's frame",
}

const PAGE = `(?:${[...PAGES, ...Object.keys(SWITCHES)].join('|')})`
const DEFINES_PAGE = new RegExp(String.raw`\bexport\s+function\s+${PAGE}\b`)
const IMPORT_ALIAS = new RegExp(String.raw`\b${PAGE}\s+as\s+(\w+)`, 'g')
const LAZY_BINDING = new RegExp(
  String.raw`\b(\w+)\s*=\s*lazy\(\s*\(\)\s*=>\s*import\([^)]*\)\s*\.then\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\(\{\s*default:\s*\2\.${PAGE}\b`,
  'g',
)
const NOTICES_MOUNT = /<KeeperNotices\s*\/>/

/** Whether code writes a page's JSX, under any name it binds the page to. */
function mountsPage(code: string): boolean {
  const names = [
    PAGE,
    ...[...code.matchAll(IMPORT_ALIAS)].map((m) => m[1]),
    ...[...code.matchAll(LAZY_BINDING)].map((m) => m[1]),
  ]
  return new RegExp(String.raw`<(?:${names.join('|')})[\s/>]`).test(code)
}

/** Whether a module writes a document page's JSX, under any name it binds the page to, and the notices'. */
function readFrame(source: string): {
  readonly holdsPage: boolean
  readonly holdsNotices: boolean
} {
  const code = stripComments(source)
  if (DEFINES_PAGE.test(code)) return { holdsPage: false, holdsNotices: false }
  return { holdsPage: mountsPage(code), holdsNotices: NOTICES_MOUNT.test(code) }
}

const RELATIVE_IMPORT = /\b(?:from\s*|import\s*\(\s*)'(\.{1,2}\/[^']+)'/g

/** The module a relative specifier names, among the scanned ones. */
function resolveImport(from: string, specifier: string): string | undefined {
  const parts = from.split('/').slice(0, -1)
  for (const part of specifier.split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '.') parts.push(part)
  }
  const base = parts.join('/').replace(/\.js$/, '')
  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((path) =>
    productionCode.has(path),
  )
}

const importers = new Map<string, string[]>()
for (const [path, code] of productionCode) {
  for (const [, specifier] of code.matchAll(RELATIVE_IMPORT)) {
    const target = resolveImport(path, specifier)
    if (target !== undefined) importers.set(target, [...(importers.get(target) ?? []), path])
  }
}

/** Modules from which `start` is reached without passing through a page: the ones that would have to be frames. */
function reachedOutsideAPage(start: string): readonly string[] {
  const roots: string[] = []
  const seen = new Set([start])
  const queue = [start]
  for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
    const next = (importers.get(path) ?? []).filter((importer) => !seen.has(importer))
    if ((importers.get(path) ?? []).length === 0) roots.push(path)
    for (const importer of next) {
      seen.add(importer)
      if (!DEFINES_PAGE.test(productionCode.get(importer) ?? '')) queue.push(importer)
    }
  }
  return roots
}

const frames = [...productionCode]
  .filter(([path]) => path.endsWith('.tsx') && !(path in NOT_FRAMES))
  .map(([path, code]) => [path, readFrame(code)] as const)
  .filter(([, frame]) => frame.holdsPage)

describe('frames that hold a document page', () => {
  it('recognise a page under an alias or a lazy binding, and only a live notices mount (self-test)', () => {
    expect(readFrame('<BrowserDocumentPage />').holdsPage).toBe(true)
    expect(
      readFrame(
        "import { DaemonDocumentPage as Page } from './pages/DaemonDocumentPage.js'\n<Page />",
      ).holdsPage,
    ).toBe(true)
    expect(
      readFrame(
        "const Doc = lazy(() =>\n  import('./D.js').then((m) => ({ default: m.DaemonDocumentPage })),\n)\n<Doc key={a} />",
      ).holdsPage,
    ).toBe(true)
    expect(
      readFrame(
        'const ReplicaReadPage = lazy(() =>\n  import(\'./pages/ReplicaReadPage.js\').then((m) => ({ default: m.ReplicaReadPage })),\n)\nfunction F() { return <div><ReplicaReadPage workspaceId="x" /></div> }',
      ),
    ).toEqual({ holdsPage: true, holdsNotices: false })
    expect(readFrame('<DocumentPageSkeleton />').holdsPage).toBe(false)
    expect(readFrame('<DaemonWorkspacePages view={view} />').holdsPage).toBe(true)
    expect(
      readFrame('export function DaemonWorkspacePages() {\n  return <DaemonDocumentPage />\n}')
        .holdsPage,
    ).toBe(false)
    expect(
      readFrame('<div>\n{/* <KeeperNotices /> is mounted by the shell */}\n<BrowserDocumentPage />')
        .holdsNotices,
    ).toBe(false)
    expect(readFrame('<KeeperNotices />\n<BrowserDocumentPage />').holdsNotices).toBe(true)
  })

  it('are the modules that publish a connection state, each a component named after its file', () => {
    expect(PAGES).toEqual(
      expect.arrayContaining(['BrowserDocumentPage', 'DaemonDocumentPage', 'ReplicaReadPage']),
    )
    for (const path of publishers) {
      expect(productionCode.get(path), path).toMatch(
        new RegExp(String.raw`\bexport\s+function\s+${moduleName(path)}\b`),
      )
    }
  })

  it('read each switch as a page, while it still mounts one', () => {
    for (const [name, path] of Object.entries(SWITCHES)) {
      const code = productionCode.get(path) ?? ''
      expect(code, path).toMatch(new RegExp(String.raw`\bexport\s+function\s+${name}\b`))
      expect(mountsPage(code), `${path} mounts no page`).toBe(true)
    }
  })

  it('exempt a module only while it mounts a page and is reached through one', () => {
    for (const path of Object.keys(NOT_FRAMES)) {
      expect(readFrame(productionCode.get(path) ?? '').holdsPage, `${path} mounts no page`).toBe(
        true,
      )
      expect(
        reachedOutsideAPage(path),
        `${path} is reached without passing through a page`,
      ).toEqual([])
      expect(importers.get(path) ?? [], `${path} is imported by nothing`).not.toEqual([])
    }
  })

  it('are found, so a broken scan cannot pass over nothing', () => {
    expect(frames.map(([path]) => path)).toEqual(
      expect.arrayContaining(['./app-screens.tsx', './pages/ServerModeWorkspace.tsx']),
    )
  })

  it("each mount the keeper's notices", () => {
    const missing = frames.filter(([, frame]) => !frame.holdsNotices).map(([path]) => path)
    expect(
      missing,
      `mounts a document page without <KeeperNotices />: ${missing.join(', ')}`,
    ).toEqual([])
  })
})
