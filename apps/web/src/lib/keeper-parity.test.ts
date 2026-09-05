// @vitest-environment node
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
 *
 * What the scan cannot see, and what the second block here is for: a
 * difference that lives entirely in the daemon's own server code reaches no
 * apps/web module at all. Automatic checkpoints are the standing example —
 * the daemon saves one after work settles and the browser keeper saves only
 * when asked, and nothing in this app fetches that. It surfaces here as a
 * PROP, and a prop with a default surfaces as nothing: the mount that
 * forgets it claims the daemon's shape in silence.
 */

import { describe, expect, it } from 'vitest'
import {
  BROWSER_HISTORY_CAPABILITIES,
  DAEMON_HISTORY_CAPABILITIES,
} from '../components/VersionTimeline.js'
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
  'src/components/MergeDialog.tsx': { reach: 'capability', capability: 'merge' },
  'src/components/PairedOriginsCard.tsx': {
    reach: 'daemon-itself',
    why: "lists and revokes the pairing grants a daemon issued to web origins — the grants are the daemon's, so a browser keeper has none to show",
  },
  'src/components/StorageReportCard.tsx': {
    reach: 'both-keepers',
    browser: 'src/lib/persistent-storage.ts',
    note: 'the daemon reports its own disk and offers optimize-all; the browser answers the same question through navigator.storage',
  },
  'src/components/MergeToast.tsx': { reach: 'capability', capability: 'merge' },
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
  'src/contexts/DaemonApiContext.tsx': {
    reach: 'daemon-itself',
    why: 'carries the authorized fetch for a connected daemon, so it is the connection itself rather than a feature built on one',
  },
  'src/contexts/VersionsBackendContext.tsx': {
    reach: 'both-keepers',
    browser: BROWSER_VERSIONS,
    note: 'the daemon backend is this context FALLBACK; the browser page provides its own',
  },
  // The branch seam, in two halves. The context is which keeper answers; the
  // backend holds the daemon's requests AND the browser's refusal. Together
  // they make the declared difference the DEFAULT rather than a flag each
  // caller passes. (`capability` entries take no `note` — the vocabulary's
  // own type says so — so this is a comment.)
  //
  // `src/hooks/useBranches.ts` is deliberately absent: it stopped reaching
  // the daemon when the transport moved out of it, and this ledger's other
  // direction fails on an entry naming a module that no longer reaches.
  'src/contexts/BranchesBackendContext.tsx': { reach: 'capability', capability: 'branches' },
  'src/lib/branches-backend.ts': { reach: 'capability', capability: 'branches' },
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
  'src/pages/PairConsentPage.tsx': {
    reach: 'daemon-itself',
    why: 'the screen where a person grants a web origin access to their daemon — it exists only because there is a daemon to pair with',
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
 * daemon's URLs from the shared helpers, it holds one of the two fetches
 * that reach it, or it writes an `/api/` path by hand.
 *
 * All four, because the narrow version of this scan MISSED the largest
 * difference in the app. The whole branch surface, which the browser keeper
 * cannot answer at all, built `/api/workspaces/${'${id}'}/documents/…` as a
 * template string and called `apiFetch`, so a pattern over the URL helpers
 * and `daemonFetch` alone did not see it. A module that reaches the daemon
 * the least conventional way is exactly the one nobody thought about the
 * browser for.
 *
 * That surface now goes through `branches-backend.ts`, which is the ordinary
 * shape — but the pattern stays wide, because what it caught was a habit
 * rather than one module.
 */
const DAEMON_REACH_PATTERN = /documentsApiUrl|workspacesApiUrl|daemonFetch|apiFetch|['"`]\/api\//

/**
 * Comments are stripped first: `WorkspaceFilesPanel` and
 * `document-embed-content` each describe an `/api/` route in prose and
 * neither calls one, and a ledger that demands an answer for a module that
 * only MENTIONS the daemon teaches people to write an entry to shut it up.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function daemonReachingModules(): string[] {
  return (
    Object.entries(sources)
      .filter(([path]) => !path.includes('.test.'))
      // Never imported at runtime: it re-exports types and one fetch to prove
      // they resolve, and says so in its own header. Nothing about a keeper.
      .filter(([path]) => !path.endsWith('/_type-probe.ts'))
      .filter(([, text]) => DAEMON_REACH_PATTERN.test(code(text)))
      .map(([path]) => path.replace(/^\//, ''))
      .sort()
  )
}

describe('every module that reaches the daemon says what the browser keeper does', () => {
  const scanned = daemonReachingModules()

  it('finds a plausible number of daemon-reaching modules', () => {
    // A regex that stopped matching would otherwise report itself below as
    // "every entry is stale", sending the reader to the wrong file entirely.
    expect(scanned.length).toBeGreaterThanOrEqual(18)
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

describe('a panel whose behaviour differs by keeper is told which keeper it is', () => {
  const mounts = Object.entries(sources)
    .filter(([path]) => !path.includes('.test.'))
    .flatMap(([path, text]) =>
      // The props group is OPTIONAL. Requiring whitespace after the name
      // skipped `<VersionTimeline/>` — a mount with no props at all, which
      // is precisely the mount this guard exists to catch, since it is the
      // one that takes the daemon's shape by default with nothing on the
      // line to say so.
      [...text.matchAll(/<(VersionPanel|VersionTimeline)(\s[^>]*?)?\/?>/g)].map((m) => ({
        path: path.replace(/^\//, ''),
        component: m[1] as string,
        props: m[2] ?? '',
      })),
    )

  it('finds every production mount of the history panel', () => {
    // Two pages decide, and VersionPanel forwards to VersionTimeline. A
    // regex that stopped matching would report zero mounts and pass every
    // case below vacuously.
    expect(mounts.length).toBeGreaterThanOrEqual(3)
  })

  it.each(
    mounts.map((m) => [`${m.path} -> ${m.component}`, m] as const),
  )('%s states its keeper', (_label, mount) => {
    // `VersionTimelineCapabilities` defaults to the daemon's shape so that
    // a test mount reads as one line. That default is exactly what makes a
    // production mount able to claim automatic checkpoints and branches it
    // does not have, without a word of code saying so — which is how a
    // keeper difference goes back to being invisible.
    expect(
      /\bcapabilities=/.test(mount.props),
      `${mount.path} mounts ${mount.component} without capabilities, so it silently takes the daemon's shape — pass DAEMON_HISTORY_CAPABILITIES or BROWSER_HISTORY_CAPABILITIES, or forward the prop it was given`,
    ).toBe(true)
  })

  it('agrees with the provider about branches', () => {
    // Two capability surfaces describing one keeper: the provider's map,
    // which gates the teaser copy, and the panel's prop, which decides
    // whether a lane column is drawn. Disagreeing is a silent difference of
    // its own — the chrome would promise branches while the panel drew one
    // lane, or the reverse.
    expect(BROWSER_HISTORY_CAPABILITIES.branches).toBe(BROWSER_CAPABILITIES.branches)
    expect(DAEMON_HISTORY_CAPABILITIES.branches).toBe(DAEMON_CAPABILITIES.branches)
  })
})
