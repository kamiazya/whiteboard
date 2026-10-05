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
 * each has one shell it wraps every screen in.
 *
 * Sources come from Vite's `import.meta.glob` (raw text), so this needs no
 * `node:fs` — apps/web is browser-only.
 */
import { describe, expect, it } from 'vitest'

const sourceModules = import.meta.glob('./**/*.tsx', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>

const DOCUMENT_PAGE_MOUNT = /<(?:Daemon|Browser)DocumentPage[\s/>]/
const NOTICES_MOUNT = /<KeeperNotices\s*\/>/

const frames = Object.entries(sourceModules).filter(
  ([path, source]) =>
    !path.includes('.test.') &&
    !path.includes('/test-utils/') &&
    !path.includes('/docs-snapshots/') &&
    DOCUMENT_PAGE_MOUNT.test(source),
)

describe('frames that hold a document page', () => {
  it('are found, so a broken scan cannot pass over nothing', () => {
    expect(frames.map(([path]) => path)).toEqual(
      expect.arrayContaining(['./app-screens.tsx', './pages/ServerModeWorkspace.tsx']),
    )
  })

  it("each mount the keeper's notices", () => {
    const missing = frames.filter(([, source]) => !NOTICES_MOUNT.test(source)).map(([path]) => path)
    expect(
      missing,
      `mounts a document page without <KeeperNotices />: ${missing.join(', ')}`,
    ).toEqual([])
  })
})
