/**
 * The keeper-capability ledger: a feature that reaches the daemon is either
 * answered by the browser keeper too, declared as a difference, or written
 * down as a gap with a follow-up. Nothing may sit undecided.
 *
 * The class this catches is the one no per-mode test can. `versions-backend.
 * contract.ts` runs one behavioural contract against both keepers, and it
 * catches a keeper that answers the seam WRONGLY — but a feature implemented
 * in one keeper and never written in the other is an absent test, not a
 * failing one, and every suite stays green over it. That is how the daemon
 * shipped the file seams while the same page in browser mode passed none of
 * them (`pages/file-seam-conformance.test.ts`, which pins that one pair);
 * this generalises it from a pair of pages to every module that reaches the
 * daemon at all.
 *
 * Scanned rather than listed, so ADDING one is what fails. A new feature
 * built the quickest way — a `documentsApiUrl` fetch straight from a
 * component — lands here as an unclassified module and stops the run until
 * somebody answers, for it, the question this whole ledger exists to ask:
 * and in the browser?
 *
 * The four answers are the vocabulary below. `gap` is a first-class one:
 * the point is not that both keepers must have everything, it is that a
 * difference is a decision somebody took rather than one nobody noticed.
 */

import { describe, expect, it } from 'vitest'
import { assertScannedLedger } from '../test-utils/coverage-ledger.js'
import { BROWSER_CAPABILITIES, DAEMON_CAPABILITIES } from './provider.js'

type KeeperReach =
  /**
   * Both keepers answer this. `browser` names the module that answers it
   * WITHOUT the daemon — a seam's other implementation, a per-keeper twin,
   * or the page that supplies the value the daemon route would have. A file
   * path rather than a concept name, because a path is checkable and a
   * concept name is a claim.
   */
  | { readonly reach: 'both-keepers'; readonly browser: string; readonly note?: string }
  /**
   * A difference the app already DECLARES, through the capability map the
   * teaser copy is built on. The user is told; nothing is silent.
   */
  | { readonly reach: 'capability'; readonly capability: keyof typeof BROWSER_CAPABILITIES }
  /** The module's subject IS the daemon connection, so there is nothing to mirror. */
  | { readonly reach: 'daemon-itself'; readonly why: string }
  /** A real difference nobody declared, with the follow-up that closes it. */
  | { readonly reach: 'gap'; readonly missing: string; readonly followUp: string }

const BROWSER_VERSIONS = 'src/lib/browser-versions-backend.ts'
const BROWSER_FILES = 'src/lib/local-files-source.ts'
const BROWSER_PAGE = 'src/pages/BrowserDocumentPage.tsx'

const DAEMON_REACH: Record<string, KeeperReach> = {
  'src/components/DocumentThumb.tsx': {
    reach: 'gap',
    missing:
      'the switcher dropdown draws a document from the daemon latest-thumbnail route, so a browser keeper shows the kind icon instead — and DocumentThumbnail, which renders the same picture from injected bytes, proves the browser could draw one',
    followUp: 'task #32',
  },
  'src/components/MergeDialog.tsx': { reach: 'capability', capability: 'merge' },
  'src/components/MergeToast.tsx': { reach: 'capability', capability: 'merge' },
  'src/components/VersionThumbnail.tsx': {
    reach: 'gap',
    missing:
      'a saved point carries a picture only for the daemon; the browser VersionsBackend leaves putThumbnail out and its rows are drawn without one',
    followUp: 'task #33',
  },
  'src/components/WorkspaceTopBar.tsx': {
    reach: 'both-keepers',
    browser: BROWSER_PAGE,
    note: 'passes a daemon fetch to useDocumentNames; the browser page hands the same bar the name from its own store',
  },
  'src/components/workspace-top-bar/useDocumentNames.ts': {
    reach: 'both-keepers',
    browser: BROWSER_PAGE,
    note: 'reads the workspace names route, and stays empty in browser mode by design — the page names its document instead',
  },
  'src/contexts/VersionsBackendContext.tsx': {
    reach: 'both-keepers',
    browser: BROWSER_VERSIONS,
    note: 'the daemon backend is this context FALLBACK; the browser page provides its own',
  },
  'src/lib/daemon-api-client.ts': {
    reach: 'both-keepers',
    browser: BROWSER_FILES,
    note: 'the daemon transport under the files surface; both bindings answer WorkspaceFilesSource',
  },
  'src/lib/daemon-file-adapter.ts': {
    reach: 'both-keepers',
    browser: 'src/lib/document-embed-content.ts',
    note: 'the two DocumentFileAdapter bindings; the seams above them are keeper-agnostic',
  },
  'src/lib/daemon-files-source.ts': { reach: 'both-keepers', browser: BROWSER_FILES },
  'src/lib/version-thumbnail.ts': {
    reach: 'gap',
    missing:
      'uploads a rendered picture for a saved point to the daemon; the browser keeper renders none and stores none',
    followUp: 'task #33',
  },
  'src/lib/versions-backend.ts': { reach: 'both-keepers', browser: BROWSER_VERSIONS },
  'src/pages/DaemonDocumentPage.tsx': {
    reach: 'both-keepers',
    browser: BROWSER_PAGE,
    note: 'the per-keeper document pages; what they must offer alike is pinned by file-seam-conformance.test.ts and page-state-conformance.test.ts',
  },
  'src/pages/DaemonIndexPage.tsx': {
    reach: 'both-keepers',
    browser: 'src/pages/BrowserIndexPage.tsx',
  },
  'src/pages/SettingsPage.tsx': {
    reach: 'daemon-itself',
    why: 'the Connections screen is where a daemon is found, paired and promoted to — its subject is the connection, so a browser keeper has nothing to mirror',
  },
  'src/pages/use-daemon-document-controller.ts': {
    reach: 'both-keepers',
    browser: 'src/pages/use-browser-document-controller.ts',
  },
}

// `?raw` rather than node:fs — apps/web is browser-only and must not import a
// Node builtin (the same reason provider.capability-reach.test.ts reads this way).
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/**
 * How a module is recognised as reaching the daemon: it builds one of the
 * daemon's URLs, or it holds the authorized fetch that carries its bearer
 * token. Both, because either alone misses a real call site — a component
 * with a URL and an injected fetch, or a hook handed `daemonFetch` and a
 * hand-written path.
 */
const DAEMON_REACH_PATTERN = /documentsApiUrl|workspacesApiUrl|daemonFetch/

function daemonReachingModules(): string[] {
  return Object.entries(sources)
    .filter(([path]) => !path.includes('.test.'))
    .filter(([, text]) => DAEMON_REACH_PATTERN.test(text))
    .map(([path]) => path.replace(/^\//, ''))
    .sort()
}

describe('every module that reaches the daemon says what the browser keeper does', () => {
  const scanned = daemonReachingModules()

  it('finds a plausible number of daemon-reaching modules', () => {
    // A regex that stopped matching would otherwise report itself below as
    // "every entry is stale", sending the reader to the wrong file entirely.
    expect(scanned.length).toBeGreaterThanOrEqual(10)
  })

  it('classifies every one of them, and names nothing that has stopped reaching', () => {
    assertScannedLedger(scanned, DAEMON_REACH, {
      unclassified:
        'these modules reach the daemon and DAEMON_REACH does not say what the browser keeper does — add an entry: both-keepers (naming the module that answers without a daemon), capability (a difference the app already declares), daemon-itself, or gap (with the follow-up that closes it)',
      stale:
        'these DAEMON_REACH entries name modules that no longer reach the daemon — delete the entry',
    })
  })
})

describe('each answer is checked, so none of them can be a word in front of an omission', () => {
  const entries = Object.entries(DAEMON_REACH)
  const known = new Set(Object.keys(sources).map((path) => path.replace(/^\//, '')))

  const bothKeepers = entries.filter(([, e]) => e.reach === 'both-keepers')
  it.each(bothKeepers)('%s names a browser answer that exists', (_path, entry) => {
    if (entry.reach !== 'both-keepers') return
    expect(
      known.has(entry.browser),
      `${entry.browser} is named as the browser keeper's answer but no such module exists — name the real one, or the entry is a gap`,
    ).toBe(true)
  })

  const capabilities = entries.filter(([, e]) => e.reach === 'capability')
  it.each(capabilities)('%s names a capability the keepers really differ on', (_path, entry) => {
    if (entry.reach !== 'capability') return
    // A flag both keepers set the same way declares no difference, so an
    // entry resting on it is claiming the user was told something they were
    // not. provider.capability-reach.test.ts holds the other half — that a
    // declared flag gates something.
    expect(
      BROWSER_CAPABILITIES[entry.capability],
      `capabilities.${entry.capability} is not false for the browser, so this module's difference is not the declared one`,
    ).toBe(false)
    expect(DAEMON_CAPABILITIES[entry.capability]).toBe(true)
  })

  const gaps = entries.filter(([, e]) => e.reach === 'gap')
  it.each(gaps)('%s names a follow-up that can be picked up', (_path, entry) => {
    if (entry.reach !== 'gap') return
    // The rule dev-loop's `userReach` sentinel already applies to a
    // foundation-only slice: a follow-up too vague to file is the omission
    // with a word in front of it.
    expect(entry.followUp, 'a gap must name the follow-up that closes it, as "task #N"').toMatch(
      /#\d+/,
    )
    expect(entry.missing.split(/\s+/).length).toBeGreaterThan(8)
  })

  const daemonItself = entries.filter(([, e]) => e.reach === 'daemon-itself')
  it.each(daemonItself)('%s says why there is nothing to mirror', (_path, entry) => {
    if (entry.reach !== 'daemon-itself') return
    expect(entry.why.split(/\s+/).length).toBeGreaterThan(8)
  })
})
