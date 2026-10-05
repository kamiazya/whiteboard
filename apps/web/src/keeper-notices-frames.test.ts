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
 * Checked per file: the frames are the modules that write the page's JSX, and
 * each has one shell it wraps every screen in. A page is recognised under its
 * own name, an import alias (`DaemonDocumentPage as Page`), or a `lazy()`
 * binding that resolves to it; comments are stripped, so a commented-out
 * `<KeeperNotices />` does not count as mounted.
 *
 * Blind spot: a page passed through a variable that is none of those (a
 * component map, a prop) is not seen as mounted.
 *
 * Sources come from Vite's `import.meta.glob` (raw text), so this needs no
 * `node:fs` — apps/web is browser-only.
 */
import { describe, expect, it } from 'vitest'
import { stripComments } from './test-utils/strip-comments.js'

const sourceModules = import.meta.glob('./**/*.tsx', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>

const PAGE = '(?:Daemon|Browser)DocumentPage'
const IMPORT_ALIAS = new RegExp(String.raw`\b${PAGE}\s+as\s+(\w+)`, 'g')
const LAZY_BINDING = new RegExp(
  String.raw`\b(\w+)\s*=\s*lazy\(\s*\(\)\s*=>\s*import\([^)]*\)\s*\.then\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\(\{\s*default:\s*\2\.${PAGE}\b`,
  'g',
)
const NOTICES_MOUNT = /<KeeperNotices\s*\/>/

/** Whether a module writes a document page's JSX, under any name it binds the page to, and the notices'. */
function readFrame(source: string): {
  readonly holdsPage: boolean
  readonly holdsNotices: boolean
} {
  const code = stripComments(source)
  const names = [
    PAGE,
    ...[...code.matchAll(IMPORT_ALIAS)].map((m) => m[1]),
    ...[...code.matchAll(LAZY_BINDING)].map((m) => m[1]),
  ]
  return {
    holdsPage: new RegExp(String.raw`<(?:${names.join('|')})[\s/>]`).test(code),
    holdsNotices: NOTICES_MOUNT.test(code),
  }
}

const frames = Object.entries(sourceModules)
  .filter(
    ([path]) =>
      !path.includes('.test.') &&
      !path.includes('/test-utils/') &&
      !path.includes('/docs-snapshots/'),
  )
  .map(([path, source]) => [path, readFrame(source)] as const)
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
    expect(readFrame('<DocumentPageSkeleton />').holdsPage).toBe(false)
    expect(
      readFrame('<div>\n{/* <KeeperNotices /> is mounted by the shell */}\n<BrowserDocumentPage />')
        .holdsNotices,
    ).toBe(false)
    expect(readFrame('<KeeperNotices />\n<BrowserDocumentPage />').holdsNotices).toBe(true)
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
