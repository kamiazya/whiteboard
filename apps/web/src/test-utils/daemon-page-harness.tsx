/**
 * What a document-page test needs that every one of them used to write by
 * hand: a Router and a sized parent around the page, the daemon client and
 * the replica schedulers answered by doubles, a stand-in for the SSE stream,
 * and the kebab menu opened.
 *
 * `vi.mock` is hoisted and must be called in the test file itself, so what is
 * exported here is the FACTORY a file passes to it. Each is reached through a
 * dynamic `import()` inside the factory, which defers the load until the
 * mocked module is first requested instead of racing the file's own imports:
 *
 *   vi.mock('../lib/replica-refresh.js', async () =>
 *     (await import('../test-utils/daemon-page-harness.js')).replicaRefreshMock())
 *
 * Nothing here imports `daemon-api-client` or `replica-refresh` at runtime —
 * that would hand the harness the very modules the factories replace.
 */

import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  writeCoreFacets,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  fireEvent,
  type RenderOptions,
  type RenderResult,
  render as rtlRender,
  screen,
} from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { type ReactElement, type ReactNode, useEffect } from 'react'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { vi } from 'vitest'
import type * as DaemonApiClient from '../lib/daemon-api-client.js'

let navigateFromProbe: ((to: string) => void) | null = null

/**
 * Stands in for whatever else changes the URL in the app (the document
 * browser, a link elsewhere): a page test mounts it to move the page to
 * another document with `navigateTo`.
 */
export function NavigationProbe(): null {
  const navigate = useNavigate()
  useEffect(() => {
    navigateFromProbe = navigate
    return () => {
      navigateFromProbe = null
    }
  }, [navigate])
  return null
}

/** Moves the router a mounted `NavigationProbe` belongs to. */
export function navigateTo(to: string): void {
  navigateFromProbe?.(to)
}

export interface InRouterOptions {
  /** Initial entry of the memory router. */
  route?: string
  /**
   * CSS height of a parent around the page. Pages fill their allotted height
   * (`h-full`) and the app shell owns the viewport in production, so a test
   * that lays the page out needs the equivalent sized parent; omit it for a
   * page whose layout is not under test.
   */
  height?: string
  /** Mount a `NavigationProbe` beside the page. */
  probe?: boolean
}

/**
 * The page inside the Router it has in `main.tsx` (it reads `useLocation` and
 * `useNavigate`). An ELEMENT rather than a render, for a `rerender(...)` that
 * has to hand over the same tree.
 */
export function inRouter(
  ui: ReactElement,
  { route = '/', height, probe = false }: InRouterOptions = {},
): ReactElement {
  const routed = (
    <MemoryRouter initialEntries={[route]}>
      {probe ? <NavigationProbe /> : null}
      {ui}
    </MemoryRouter>
  )
  return height === undefined ? routed : <div style={{ height }}>{routed}</div>
}

export function renderInRouter(
  ui: ReactElement,
  { route, height, probe, ...options }: InRouterOptions & RenderOptions = {},
): RenderResult {
  return rtlRender(inRouter(ui, { route, height, probe }), options)
}

/** `inRouter` inside a parent as high as the viewport, which is what the app shell gives a page. */
export function inPage(ui: ReactElement, options: InRouterOptions = {}): ReactElement {
  return inRouter(ui, { height: '100vh', ...options })
}

export function renderPage(
  ui: ReactElement,
  { route, height = '100vh', probe, ...options }: InRouterOptions & RenderOptions = {},
): RenderResult {
  return renderInRouter(ui, { route, height, probe, ...options })
}

/**
 * RTL's `wrapper` form of the same Router. RTL re-applies a wrapper on every
 * `rerender`, so a test that rerenders the BARE page keeps its Router.
 */
export function MemoryRouterWrapper({ children }: { children: ReactNode }): ReactElement {
  return <MemoryRouter initialEntries={['/']}>{children}</MemoryRouter>
}

export function renderWithRouterWrapper(ui: ReactElement, options?: RenderOptions): RenderResult {
  return rtlRender(ui, { wrapper: MemoryRouterWrapper, ...options })
}

/**
 * Replaces `lib/replica-refresh`. The page schedules ADR-0023's replica pull
 * and push in the background, on an idle callback or a timer; left real they
 * fire mid-file against a fetch double shaped for something else, and the
 * warning that follows is charged to whichever case is executing by then.
 * Each scheduler answers the CANCEL the page calls on unmount.
 */
export function replicaRefreshMock() {
  return {
    scheduleReplicaRefresh: vi.fn(() => () => {}),
    scheduleReplicaPush: vi.fn(() => () => {}),
  }
}

type DaemonApiClientModule = typeof DaemonApiClient
type DocumentSummary = Awaited<
  ReturnType<DaemonApiClientModule['listDocuments']>
>['documents'][number]
type DaemonApiFunctionName = {
  [K in keyof DaemonApiClientModule]: DaemonApiClientModule[K] extends (...args: never[]) => unknown
    ? K
    : never
}[keyof DaemonApiClientModule]

/**
 * Replaces `lib/daemon-api-client` by the functions a file drives: each name
 * in `replaced` becomes a `vi.fn` (answering `defaults[name]` until the test
 * says otherwise), and every other export stays real — the error classes, the
 * parsers, a call the file does not stub.
 */
export async function daemonApiClientMock(
  importOriginal: <T>() => Promise<T>,
  replaced: readonly DaemonApiFunctionName[],
  defaults: Partial<Pick<DaemonApiClientModule, DaemonApiFunctionName>> = {},
): Promise<DaemonApiClientModule> {
  const actual = await importOriginal<DaemonApiClientModule>()
  const stubs = Object.fromEntries(replaced.map((name) => [name, vi.fn(defaults[name])]))
  return { ...actual, ...stubs }
}

/**
 * Answers for a daemon that keeps one document in workspace `w1`: the
 * defaults for `daemonApiClientMock` when a test mounts straight onto it
 * rather than setting each answer per case.
 */
export function daemonWithOneDocument(
  row: Pick<DocumentSummary, 'path' | 'documentId' | 'kind'>,
): Pick<DaemonApiClientModule, 'listWorkspaces' | 'listDocuments' | 'getDocumentBacklinks'> {
  return {
    listWorkspaces: async () => ({ workspaces: [{ workspaceId: 'w1' }] }),
    listDocuments: async () => ({ documents: [{ updatedAt: '2026-01-01', ...row }] }),
    getDocumentBacklinks: async () => ({ backlinks: [], unlinkedMentions: [] }),
  }
}

/** The workspace snapshot a daemon's `scope=workspace` stream delivers for one markdown document. */
export function markdownWorkspaceSnapshot(doc: {
  path: string
  documentId: string
  body: string
}): Uint8Array {
  const loro = new LoroDoc()
  createWorkspaceDocumentAtPath(loro, {
    path: doc.path,
    documentId: doc.documentId,
    kind: 'markdown',
  })
  const containers = documentContainers(loro, doc.documentId)
  writeMarkdownBody(containers, doc.body)
  writeCoreFacets(containers, { type: 'markdown' })
  loro.commit()
  return loro.export({ mode: 'snapshot' })
}

export interface FakeSseBackendOptions {
  /** Called with the arguments the page built the backend from. */
  onConstruct?: (workspaceId: string, path: string) => void
  /**
   * What the stream delivers for the path it was built for. Without it the
   * backend connects to nothing — enough for a test about WHICH backend the
   * page builds.
   */
  snapshotFor?: (path: string) => Uint8Array
}

/**
 * Replaces `SseBackend`, the daemon's document stream: connects at once,
 * delivers a snapshot, and persists nothing.
 */
export function fakeSseBackendModule({ onConstruct, snapshotFor }: FakeSseBackendOptions = {}) {
  return {
    SseBackend: class {
      constructor(
        readonly workspaceId: string,
        readonly path: string,
      ) {
        onConstruct?.(workspaceId, path)
      }
      connect(handlers: DocumentBackendHandlers): void {
        if (snapshotFor === undefined) return
        handlers.onConnected()
        handlers.onSnapshot(snapshotFor(this.path))
      }
      disconnect(): void {}
      pushLocalUpdate(): void {}
      sendClientReady(): void {}
    },
  }
}

/**
 * Opens the document's kebab and resolves to its menu. Radix opens a
 * dropdown on pointer DOWN, not click, and items select on pointer UP; the
 * menu mounts asynchronously.
 */
export async function openDocumentOpsMenu(): Promise<HTMLElement> {
  const trigger = await screen.findByRole('button', { name: 'More actions' })
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
  return screen.findByRole('menu')
}

const emptySnapshot = (): Uint8Array => new LoroDoc().export({ mode: 'snapshot' })

/**
 * The document stream a page is handed through `createBackend`: connects at
 * once, delivers `seed()`, and records what the page did to it. A test that
 * needs to know which arguments the page built it from subclasses it.
 */
export class FakeDocumentBackend implements DocumentBackend {
  handlers: DocumentBackendHandlers | null = null
  readonly pushed: Uint8Array[] = []
  /**
   * The exact bytes the page hydrated from: a replay of `pushed` must import
   * into the SAME doc lineage, not a structurally-equal rebuild with different
   * Loro op ids.
   */
  snapshot: Uint8Array = new Uint8Array()
  connectCount = 0
  disconnectCount = 0

  constructor(private readonly seed: () => Uint8Array = emptySnapshot) {}

  connect(handlers: DocumentBackendHandlers): void {
    this.connectCount += 1
    this.handlers = handlers
    handlers.onConnected()
    this.snapshot = this.seed()
    handlers.onSnapshot(this.snapshot)
  }

  disconnect(): void {
    this.disconnectCount += 1
  }

  pushLocalUpdate(update: Uint8Array): void {
    this.pushed.push(update)
  }

  sendClientReady(): void {}
}
