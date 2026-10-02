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
 * The three answers are the vocabulary below. `gap` is a first-class one:
 * the point is not that both keepers must have everything, it is that a
 * difference is a decision somebody took rather than one nobody noticed.
 *
 * What the scan cannot see: a difference living entirely in the daemon's own
 * server code reaches no apps/web module at all. A second block here used to
 * cover one such case — automatic checkpoints, which surfaced as a
 * `VersionTimelineCapabilities` prop whose default silently claimed the
 * daemon's shape — and it is gone because the difference is: the browser
 * keeper checkpoints too, the prop was deleted with the pair, and a guard
 * whose subject no longer exists is a guard that cannot fail. A difference
 * of that shape again needs a new guard written against whatever carries it,
 * not this one revived.
 */

import { describe, expect, it } from 'vitest'
import { assertScannedLedger } from '../test-utils/coverage-ledger.js'

type KeeperReach =
  /**
   * Both keepers answer this. `browser` names the module that answers it
   * WITHOUT the daemon — a seam's other implementation, a per-keeper twin,
   * or the page that supplies the value the daemon route would have. A file
   * path rather than a concept name, because a path is checkable and a
   * concept name is a claim.
   */
  | { readonly reach: 'both-keepers'; readonly browser: string; readonly note?: string }
  // A `capability` answer stood here, for a difference the app DECLARED
  // through a capability map. That map is gone — every flag in it left as the
  // browser keeper grew the feature, because a flag both keepers set the same
  // way declares no difference — so the answer is gone with it. A real
  // declared difference would bring both back together.
  /** The module's subject IS the daemon connection, so there is nothing to mirror. */
  | { readonly reach: 'daemon-itself'; readonly why: string }
  /** A real difference nobody declared, with the follow-up that closes it. */
  | { readonly reach: 'gap'; readonly missing: string; readonly followUp: string }

const BROWSER_VERSIONS = 'src/lib/browser-versions-backend.ts'
const BROWSER_FILES = 'src/lib/local-files-source.ts'
const BROWSER_PAGE = 'src/pages/BrowserDocumentPage.tsx'

const DAEMON_REACH: Record<string, KeeperReach> = {
  'src/lib/member-workspaces.ts': {
    reach: 'daemon-itself',
    why: "lists the workspaces a server-mode keeper lets the signed-in person reach, for its entrance and its shell (ADR-0047); membership is a server keeper's idea, and a browser keeper has one person and every workspace, so there is nothing to mirror",
  },
  'src/lib/server-people.ts': {
    reach: 'daemon-itself',
    why: "manages a server-mode keeper's people — its users, administrators, workspace owners and invitations (ADR-0049); a browser keeper has one person, who is every workspace's owner, so there is nobody to manage and nothing to mirror",
  },
  'src/components/server-mode/ServerModeShell.tsx': {
    reach: 'daemon-itself',
    why: 'signs the person out of a server-mode keeper through its `/auth/sign-out` route; a Browser keeper has no sign-in, so there is no session to end and nothing to mirror',
  },
  'src/pages/ServerModeApp.tsx': {
    reach: 'daemon-itself',
    why: "the server-mode keeper's own entrance: it reads `/auth/providers` and `/auth/session` to sign the person in before any workspace opens; a Browser keeper has no sign-in, so there is no entrance to mirror",
  },
  'src/pages/ServerModePeoplePage.tsx': {
    reach: 'daemon-itself',
    why: "sends the person to a server-mode keeper's `/auth/reauthenticate` before it manages people; a Browser keeper has no sign-in and one person, so there is nobody to re-authenticate and nothing to mirror",
  },
  'src/lib/accept-transferred-record.ts': {
    reach: 'daemon-itself',
    why: 'merges a workspace record arriving from ANOTHER origin into a workspace this keeper holds — it runs on the page a keeper serves at its own address, and a browser keeper serves no address anyone could send a transfer to, so there is no receiving side to mirror',
  },
  'src/components/settings/PromoteWorkspaceSection.tsx': {
    reach: 'daemon-itself',
    why: 'moves a browser-kept workspace INTO the daemon and shows what the daemon keeps of the workspace in view (its replica tier line) — both are about the daemon as the destination or the keeper, and a browser-kept workspace has no counterpart for either',
  },
  'src/components/settings/LocalCopiesCard.tsx': {
    reach: 'daemon-itself',
    why: "hands the connected daemon's fetch to each of that daemon's cached copies, for the offline switch below — a browser-kept workspace is stored unsealed, so there is no key to lock and nothing to hand",
  },
  'src/components/settings/ReplicaOfflineControl.tsx': {
    reach: 'daemon-itself',
    why: "asks the daemon for a cached copy's key to lock it under a passkey held in this browser — only a daemon-kept copy is sealed, so a browser-kept one has no key to lock",
  },
  'src/components/storage-maintenance.ts': {
    reach: 'both-keepers',
    browser: 'src/lib/persistent-storage.ts',
    note: "the card's sweep half, extracted from it — same answer, same browser counterpart",
  },
  'src/components/StorageReportCard.tsx': {
    reach: 'both-keepers',
    browser: 'src/lib/persistent-storage.ts',
    note: 'the daemon reports its own disk and offers optimize-all; the browser answers the same question through navigator.storage',
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
  // backend holds the daemon's requests. They were `capability` entries while
  // only the daemon had variations; the browser keeps its own on the
  // workspace record now, so the difference they named is gone and the answer
  // is the ordinary one — a browser module that answers without a daemon.
  //
  // `src/hooks/useBranches.ts` is deliberately absent: it stopped reaching
  // the daemon when the transport moved out of it, and this ledger's other
  // direction fails on an entry naming a module that no longer reaches.
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
  'src/pages/daemon-document-slots.tsx': {
    reach: 'both-keepers',
    browser: 'src/pages/browser-document-slots.tsx',
    note: "each keeper page's terminal screens and model slots, extracted so the page's own hook stays under the complexity budget; the browser half answers the same questions without a daemon",
  },
  'src/pages/DaemonIndexPage.tsx': {
    reach: 'both-keepers',
    browser: 'src/pages/BrowserIndexPage.tsx',
  },
  'src/pages/daemon-index-actions.ts': {
    reach: 'both-keepers',
    browser: 'src/lib/duplicate-browser-document.ts',
    note: "the row actions each index page performs on the panel's behalf. The browser's delete helpers are inline in BrowserIndexPage; its duplicate is one definition for both browser surfaces, since the row has only a path while the open page also owes a flush and a switch",
  },
  'src/pages/SettingsPage.tsx': {
    reach: 'daemon-itself',
    why: 'the Connections screen is where a daemon is connected and promoted to — its subject is the connection, so a browser keeper has nothing to mirror',
  },
  'src/pages/use-daemon-connections.ts': {
    reach: 'both-keepers',
    browser: 'src/pages/use-browser-connections.ts',
    note: 'both halves hand a read to one keeper-agnostic hook (`use-connections.ts`) and answer from the same reference graph. Link runs the same `linkifyMentionsIn` on both; only where the source is saved differs',
  },
  'src/pages/use-daemon-document-controller.ts': {
    reach: 'both-keepers',
    browser: 'src/pages/use-browser-document-controller.ts',
  },
  'src/pages/use-daemon-document-backend.ts': {
    reach: 'both-keepers',
    browser: BROWSER_PAGE,
    note: 'both pages decide which backend to sync through; the browser half is one inline memo over `BrowserBackend` keyed on the document id, because a browser-kept document has no transport to choose, no token to carry and no session to be refused — which is most of what this module is',
  },
  'src/lib/extension-connection.ts': {
    reach: 'daemon-itself',
    why: 'asks whether the whiteboard extension can reach a daemon at all — the answer is a daemon connection, so a browser-kept workspace, which is not connected to anything, has no counterpart',
  },
  'src/lib/promote-workspace.ts': {
    reach: 'daemon-itself',
    why: "posts a browser-kept workspace's record to the keeper that is to hold it, and the files it references — the destination is the daemon, and the browser keeper is the source, so the move has no mirror",
  },
  'src/lib/replica-cache.ts': {
    reach: 'daemon-itself',
    why: "pulls a daemon workspace's record into this browser as a cached copy — only a daemon-kept workspace has a replica, since a browser-kept one is already held here and is the authority itself",
  },
  'src/lib/replica-push.ts': {
    reach: 'daemon-itself',
    why: 'ships the edits a cached copy took offline back to the daemon that holds the workspace — a browser-kept workspace has no other keeper to ship them to',
  },
  'src/lib/replica-refresh.ts': {
    reach: 'daemon-itself',
    why: "keeps this browser's cached copy of a daemon workspace fresh while that workspace is open — a browser-kept workspace has no cached copy to refresh",
  },
  'src/lib/replica-unlock.ts': {
    reach: 'daemon-itself',
    why: "fetches a cached copy's key from the daemon and opens one remembered on disk — only a daemon-kept copy is sealed, so a browser-kept workspace has no key to fetch or open",
  },
  'src/hooks/use-transfer-handshake.ts': {
    reach: 'daemon-itself',
    why: 'the receiving side of a cross-origin transfer into a workspace this daemon holds, through `accept-transferred-record.ts` — a browser keeper serves no address a transfer could arrive at, so there is no receiving side to mirror',
  },
  'src/hooks/use-shell-workspaces.ts': {
    reach: 'both-keepers',
    browser: 'src/lib/browser-workspaces.ts',
    note: "builds both keepers' halves of the workspace switcher side by side; the browser half is the registry in browser-workspaces.ts, answering the same WorkspaceSwitcherSource",
  },
  'src/lib/duplicate-daemon-document.ts': {
    reach: 'both-keepers',
    browser: 'src/lib/duplicate-browser-document.ts',
    note: 'the daemon copy runs through endpoints, the browser copy through its own store; both keep the create-then-write-then-name order',
  },
  'src/lib/theme-fonts.ts': {
    reach: 'both-keepers',
    browser: 'src/hooks/useThemeFonts.ts',
    note: "the daemon pass lists and downloads the daemon's installed families; a browser-kept workspace fetches the same families from the catalogue's pinned source through loadThemeFontFromSource, which this hook calls",
  },
  'src/hooks/useDaemonThemeFonts.ts': {
    reach: 'both-keepers',
    browser: 'src/hooks/useThemeFonts.ts',
    note: "loads the families a theme names from the connected daemon; the browser keeper's realm loads them from the catalogue source instead",
  },
  'src/components/FontsCard.tsx': {
    reach: 'daemon-itself',
    why: "installs a font onto the daemon's disk so ITS export draws the face — a browser keeper exports in this page, which already draws any family it holds, so there is no server-side font set to manage",
  },
  'src/lib/replica-store.ts': {
    reach: 'both-keepers',
    browser: 'src/lib/idb-document-store.ts',
    note: 'the one store factory: a daemon replica is sealed under the session key, a browser-kept workspace is the inner IdbDocumentStore unsealed',
  },
}

// `?raw` rather than node:fs — apps/web is browser-only and must not import a
// Node builtin (`web-app-boundary.test.ts` pins that).
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/**
 * How a module is recognised as reaching the daemon: it builds one of the
 * daemon's URLs from the shared helpers (`documentsApiUrl`,
 * `documentFileApiUrl`, `trashApiUrl`, … — any `*ApiUrl(` call), it holds one
 * of the two fetches that reach it, it writes an `/api/` path by hand, or it
 * calls the daemon client's request functions. A keeper's own `/auth/` routes
 * count too: sign-in is a thing only a server-mode keeper has, and a module
 * that reaches it is exactly one that has to say what a Browser keeper does.
 *
 * The `/api/` arm takes no quote in front of it, because a path built as a
 * template (`${base}/api/…`) starts with an interpolation, not a quote.
 *
 * All of them, because the narrow version of this scan MISSED the largest
 * difference in the app. The whole branch surface, which the browser keeper
 * cannot answer at all, built `/api/workspaces/${'${id}'}/documents/…` as a
 * template string and called `apiFetch`, so a pattern over the URL helpers
 * and `daemonFetch` alone did not see it. A module that reaches the daemon
 * the least conventional way is exactly the one nobody thought about the
 * browser for.
 */
const DAEMON_REACH_PATTERN =
  /documentsApiUrl|workspacesApiUrl|daemonFetch|apiFetch|\/api\/|\/auth\/|\w+ApiUrl\(/

const CLIENT_MODULE = String.raw`['"][^'"]*\/daemon-api-client(?:\.js)?['"]`
const CLIENT_DYNAMIC_IMPORT = new RegExp(String.raw`import\(\s*${CLIENT_MODULE}`)
const CLIENT_NAMED_IMPORT = new RegExp(
  String.raw`import\s+(type\s+)?\{([^}]*)\}\s*from\s*${CLIENT_MODULE}`,
  'g',
)

/**
 * A module reaches the daemon through the client without writing a URL, so
 * the URL arms above never see it. Importing only `DaemonApiError` or types
 * from the client is not a reach — reading a refusal is not asking for one.
 */
function callsDaemonClient(text: string): boolean {
  if (CLIENT_DYNAMIC_IMPORT.test(text)) return true
  return [...text.matchAll(CLIENT_NAMED_IMPORT)].some(([, typeOnly, names]) => {
    if (typeOnly) return false
    return (names ?? '')
      .split(',')
      .map((name) => name.trim())
      .some((name) => name !== '' && name !== 'DaemonApiError' && !name.startsWith('type '))
  })
}

function reachesDaemon(text: string): boolean {
  const source = code(text)
  return DAEMON_REACH_PATTERN.test(source) || callsDaemonClient(source)
}

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
      // A fake daemon answers for the daemon in a test; it is not a module the
      // app ships, so it has no keeper to be compared with.
      .filter(([path]) => !path.startsWith('/src/test-utils/'))
      .filter(([, text]) => reachesDaemon(text))
      .map(([path]) => path.replace(/^\//, ''))
      .sort()
  )
}

describe('every module that reaches the daemon says what the browser keeper does', () => {
  const scanned = daemonReachingModules()

  it.each([
    ["fetch('/auth/session')", true],
    ['fetch(base + "/auth/sign-out")', true],
    ["fetch('/api/workspaces')", true],
    ["// fetch('/auth/session') in a comment", false],
    ["const author = '/authors/x'", false],
  ])('recognises %s as reaching a keeper: %s', (text, reaches) => {
    expect(reachesDaemon(text)).toBe(reaches)
  })

  it('finds a plausible number of daemon-reaching modules', () => {
    // A regex that stopped matching would otherwise report itself below as
    // "every entry is stale", sending the reader to the wrong file entirely.
    expect(scanned.length).toBeGreaterThanOrEqual(15)
  })

  it('classifies every one of them, and names nothing that has stopped reaching', () => {
    assertScannedLedger(scanned, DAEMON_REACH, {
      unclassified:
        'these modules reach the daemon and DAEMON_REACH does not say what the browser keeper does — add an entry: both-keepers (naming the module that answers without a daemon), daemon-itself, or gap (with the follow-up that closes it)',
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

  const gaps = entries.filter(([, e]) => e.reach === 'gap')
  it.each(gaps)('%s names a follow-up that can be picked up', (_path, entry) => {
    if (entry.reach !== 'gap') return
    // The rule dev-loop's `userReach` sentinel already applies to a
    // foundation-only slice: a follow-up too vague to file is the omission
    // with a word in front of it.
    //
    // Two forms, because the repo has two ticket stores and `#\d+` named only
    // one: the native Task list is the LIVE board (`task #36: <what>`), and a
    // whiteboard document is the DURABLE backlog, named by its PATH under
    // `issues/`, which is where a follow-up nobody is working this session
    // belongs. `dev-flow.md` names both and GitHub Issues neither. The path
    // must carry at least two hyphenated words, so the widening does not
    // admit `issues/x`.
    expect(
      entry.followUp,
      'a gap must name the follow-up that closes it: a live "task #N: <what>", or a durable whiteboard document path under issues/',
    ).toMatch(/#\d+|issues\/[a-z0-9]+(-[a-z0-9]+)+/)
    expect(entry.missing.split(/\s+/).length).toBeGreaterThan(8)
  })

  const daemonItself = entries.filter(([, e]) => e.reach === 'daemon-itself')
  it.each(daemonItself)('%s says why there is nothing to mirror', (_path, entry) => {
    if (entry.reach !== 'daemon-itself') return
    expect(entry.why.split(/\s+/).length).toBeGreaterThan(8)
  })
})
