/**
 * The whole document state for a markdown-kind canvas — body text plus OKF
 * core facets — served from the WORKSPACE document when this browser has
 * one, with the legacy per-document Loro record as the fallback.
 *
 * Workspace mode is the markdown twin of the spatial editor's scoped sync
 * session: the hook holds the workspace Loro document, reads and writes this
 * document's containers through `documentContainers`, and persists through
 * `BrowserWorkspaceDocs`' shared incremental save. The startup fold runs on
 * load (the markdown page has no BrowserBackend to run it), so a document an
 * older build kept per-record is in the tree before the mode is chosen.
 * Legacy mode — no readable workspace record, or a document the fold left
 * behind — keeps the old shape: a per-document doc, saved as a full
 * snapshot through the injected store, which is also what jsdom tests'
 * injected doubles exercise.
 *
 * Body and facets share ONE host on purpose. They live in different
 * containers of the same document ('body' text, 'core' map); two hooks
 * with independent instances would overwrite each other's container on the
 * next save.
 *
 * Loading tolerates every failure by starting empty: a note the store cannot
 * decode should degrade to "empty, editable, next save overwrites" rather
 * than a dead page.
 */

import {
  type DocumentContainers,
  documentContainers,
  MARKDOWN_BODY_KEY,
  readAnnotations,
  readCoreFacets,
  readMarkdownBody,
  resolveWorkspaceDocumentById,
  setWorkspaceDocumentName,
  writeCoreFacets,
  writeMarkdownBody,
  writeThreadMessage,
} from '@kamiazya/whiteboard-loro-adapter'
import type { CommentMessage, CommentThread, StoredCoreFacets } from '@kamiazya/whiteboard-model'
import { Loro, type LoroText } from 'loro-crdt'
import { useCallback, useEffect, useRef, useState } from 'react'
import { isGeneratedDocumentPath } from '../components/workspace-files/new-document-path.js'
import { sameAnnotations } from '../lib/annotations-equal.js'
import { getAppLogger } from '../lib/app-logger.js'
import type { BrowserPersistenceState } from '../lib/browser-persistence-state.js'
import { BrowserWorkspaceDocs, openWorkspaceOrNull } from '../lib/browser-workspace-docs.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { foldWorkspaceDocuments } from '../lib/fold-workspace.js'
import { touchContentTimestamp } from '../lib/loro-store.js'
import { titleFromMarkdownBody } from '../lib/title-from-body.js'
import { createSaveScheduler, type SaveScheduler } from './save-scheduler.js'
import type { LoroStoreLike } from './use-browser-document-controller.js'

const log = getAppLogger('markdown-document')

const pendingFlushes = new Map<string, Promise<unknown>>()

/**
 * Exported so a test waiting on a save waits on the REAL period rather than
 * a copy of it. A browser test that hardcodes 500 goes quietly wrong the day
 * this changes — and what it goes wrong as is a lost-keystrokes failure, not
 * a timing one.
 */
export const SAVE_DEBOUNCE_MS = 500

/**
 * Where this document's content lives for the lifetime of one load: the doc
 * to subscribe and bind, the containers body/core sit in, and how a change
 * is persisted.
 */
interface ContentHost {
  readonly mode: 'workspace' | 'legacy'
  readonly doc: Loro
  readonly containers: DocumentContainers
  save(): Promise<void>
}

/**
 * Every save for a document goes through one queue, and the load effect
 * awaits it. Two invariants ride on that:
 *
 * - A load must not read the store while a save it should see is in flight,
 *   or it reloads pre-edit state and the edit is gone (the debounce that
 *   held it is already spent).
 * - Two saves must not land out of order. A legacy save is a full snapshot
 *   export, so an earlier one landing last puts the document back to where
 *   it was.
 *
 * Keyed per document and module-level because the writers that need to share
 * it — a cleanup closure and the next effect instance — share nothing else.
 * Never rejects: a failed save is swallowed here exactly as a fire-and-forget
 * one was, so it cannot leave the queue permanently poisoned.
 */

function queueSave(documentId: string, save: () => Promise<void>): Promise<void> {
  const previous = pendingFlushes.get(documentId)
  const next = Promise.resolve(previous)
    .then(() => save())
    .catch(() => {})
    .finally(() => {
      if (pendingFlushes.get(documentId) === next) pendingFlushes.delete(documentId)
    })
  pendingFlushes.set(documentId, next)
  return next
}

/**
 * `type` is the one required core facet, so a canvas with nothing stored
 * still needs a value before anything can be written. It names what the
 * document IS rather than how it is stored — but a markdown note starting
 * as `markdown` is both true and the least surprising default, and the
 * field is free text the moment the user disagrees.
 */
export const DEFAULT_MARKDOWN_CORE_FACETS: StoredCoreFacets = { type: 'markdown' }

/**
 * What the indicator says about a document nothing has written yet: no
 * unsaved edits, and no save this session. Named rather than written twice,
 * so the initial value and the value a switch goes back to cannot drift.
 */
const INITIAL_SAVE_STATE: BrowserPersistenceState = { kind: 'saved', lastSavedAt: null }

export interface MarkdownDocumentState {
  /** Null until the initial load resolves — render nothing editable before. */
  readonly body: string | null
  readonly setBody: (next: string) => void
  /**
   * Whether this hook's own debounced write has landed.
   *
   * Published because the page's save indicator reads the CONTROLLER's
   * persistence, which a body edit never touches — so without this the dot
   * reported `Saved` over text that had not been written. The page merges the
   * two (`mergePersistence`); this side answers only for the body.
   */
  readonly saveState: BrowserPersistenceState
  /** Null until the initial load resolves, mirroring `body`. */
  readonly coreFacets: StoredCoreFacets | null
  readonly setCoreFacets: (next: StoredCoreFacets) => void
  /**
   * The loaded Loro instance, for composition-root CRDT bindings
   * (loro-codemirror). Null until the initial load resolves. In workspace
   * mode this is the WORKSPACE document — which is why the binding must go
   * through `bodyTextOf` below rather than assuming a root container. A
   * binding mutates the body text container and commits directly — the doc
   * subscription below is what keeps `body` state and the save schedule in
   * step with commits this hook did not make.
   */
  readonly doc: Loro | null
  /**
   * The 'body' text container inside `doc` — a root container in legacy
   * mode, this document's tree-node container in workspace mode. The one
   * accessor a CRDT binding may use; resolved live, so it stays valid
   * across a move.
   */
  readonly bodyTextOf: (doc: Loro) => LoroText
  /**
   * Every conversation on this document (ADR-0026 step 3).
   *
   * Read here rather than through the sync session because a markdown
   * document deliberately has NO backend — the spatial sync layer would
   * clobber the body this hook writes — so the session sits idle and its
   * annotation channel never speaks. That left the rail permanently empty
   * on a note, with a door to conversations an MCP peer could write and
   * nothing in the app could read.
   *
   * The threads plane is a peer of `body`, not something inside a canvas
   * envelope, so the host this hook already holds is exactly the right
   * place to read it from.
   *
   * Empty until the load resolves, and empty for a document with none —
   * one value, because "no conversations" and "not yet known" produce the
   * same rail and a null would only make every consumer say so twice.
   */
  readonly annotations: readonly CommentThread[]
  /**
   * Appends one message to a conversation on this document.
   *
   * A no-op for a thread this document does not hold, and for a document
   * still loading — `writeThreadMessage` refuses to open a container it did
   * not find, because a reply must never be the write that creates a thread
   * (two replicas creating one under the same key merge to one of them, and
   * the other side's messages are gone).
   *
   * The commit it makes is a local one, so the subscription above both
   * republishes the layer and schedules the save; nothing here has to do
   * either by hand.
   */
  readonly replyToThread: (threadId: string, message: CommentMessage) => void
}

/**
 * Shared so the initial value and the value a document switch goes back to
 * are one identity — a fresh `[]` each time would re-render every consumer
 * of the rail on every switch for no change.
 */
const NO_ANNOTATIONS: readonly CommentThread[] = []

/**
 * Names a document after the title its body announces, while nobody has
 * named it and nobody has placed it.
 *
 * Someone who opens a note and types `# Weekly review` has said what it is
 * called. Without this the workspace keeps calling it `untitled`, in the
 * card, the URL and every search result, and the only way to fix that is to
 * type the same words a second time into the rename dialog.
 *
 * Two gates, and the second is the load-bearing one. `name` absent means
 * "nobody named it" — but it is ALSO what the rename dialog leaves behind
 * when someone deliberately clears a name to show the path instead, and
 * re-seeding over that would be this codebase's recurring defect: state
 * keyed on something that has since changed. A still-generated path is the
 * proxy that separates them, since anyone who cleared a name on a document
 * they had also placed has engaged with naming.
 *
 * The PATH is never touched. ADR-0008 measured deriving one from a display
 * name and found every non-Latin title collapsing to `untitled-N`; ADR-0007's
 * addendum retracted it. Seeding the name leaves the address alone, so a
 * heading edit can never move a document out from under a link.
 *
 * Runs on every save, and KEEPS UP with a heading still being typed. Typing
 * outlasts the 500ms debounce on a loaded machine, so a save lands while the
 * title is half written — and a first version of this stopped there, because
 * a name being present was what closed its gate. Measured in a real browser:
 * `# From` … ` the list` produced a document called "From", forever. A wrong
 * name is worse than `untitled`, because it looks deliberate.
 *
 * So a name this function produced may be replaced, and the test for "this
 * one is ours" is that the title still STARTS WITH it — which is exactly the
 * shape a half-typed heading leaves behind. Any other name is a person's, and
 * is never touched: rename to "Meeting" over a body reading `# From the list`
 * and the seeding is finished with this document.
 */
function seedNameFromTitle(workspace: Loro, documentId: string): void {
  const entry = resolveWorkspaceDocumentById(workspace, documentId)
  if (entry === null) return
  if (!isGeneratedDocumentPath(entry.path)) return
  const title = titleFromMarkdownBody(
    documentContainers(workspace, documentId).getText(MARKDOWN_BODY_KEY).toString(),
  )
  if (title === undefined || title === entry.name) return
  // Absent: nobody has named it. A strict prefix of the title: we named it,
  // from a heading that has since grown.
  const ours = entry.name === undefined || title.startsWith(entry.name)
  if (!ours) return
  setWorkspaceDocumentName(workspace, { documentId, name: title })
}

async function openWorkspaceHost(documentId: string): Promise<ContentHost | null> {
  // The fold first: the markdown page has no BrowserBackend, so this is the
  // one place a markdown-only visit carries an older build's per-document
  // record into the tree. Non-fatal — see the backend's identical guard.
  try {
    await foldWorkspaceDocuments()
  } catch (err) {
    log.warn('startup fold failed; continuing without it', err)
  }
  const docs = new BrowserWorkspaceDocs()
  const workspace = await openWorkspaceOrNull(docs)
  if (workspace === null) return null
  if (resolveWorkspaceDocumentById(workspace, documentId) === null) return null
  return {
    mode: 'workspace',
    doc: workspace,
    containers: documentContainers(workspace, documentId),
    save: async () => {
      seedNameFromTitle(workspace, documentId)
      await docs.save(getBrowserWorkspaceId(), workspace)
      await touchContentTimestamp(documentId)
    },
  }
}

async function openLegacyHost(loro: LoroStoreLike, documentId: string): Promise<ContentHost> {
  const doc = new Loro()
  try {
    const result = await loro.load(documentId)
    if (result.kind === 'ok') {
      doc.import(result.snapshot)
      for (const delta of result.deltas ?? []) doc.import(delta)
    }
  } catch {
    // degrade to empty — see module doc
  }
  return {
    mode: 'legacy',
    doc,
    containers: doc,
    save: () => loro.save(documentId, doc.export({ mode: 'snapshot' })),
  }
}

export function useMarkdownDocument(
  loro: LoroStoreLike,
  documentId: string | null,
  enabled: boolean,
): MarkdownDocumentState {
  const [body, setBodyState] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<BrowserPersistenceState>(INITIAL_SAVE_STATE)
  // Through a ref: the debounce closure and the unmount flush both report,
  // and neither may re-arm the timer by depending on the setter's identity.
  const setSaveStateRef = useRef(setSaveState)
  setSaveStateRef.current = setSaveState
  // Mirrors the scope itself, rewritten every render: a scheduler outlives
  // the document it was made for (its flush settles after the switch), so at
  // report time it has to ask who the hook is about NOW, not who it was
  // created for.
  const currentDocumentIdRef = useRef(documentId)
  currentDocumentIdRef.current = documentId
  const [coreFacets, setCoreMetaState] = useState<StoredCoreFacets | null>(null)
  const [doc, setDoc] = useState<Loro | null>(null)
  const [annotations, setAnnotations] = useState<readonly CommentThread[]>(NO_ANNOTATIONS)
  const hostRef = useRef<ContentHost | null>(null)
  const loroRef = useRef(loro)
  loroRef.current = loro

  // See queueSave: the load below awaits whatever save is still in flight
  // for this document before reading the store.
  const pending = pendingFlushes

  // SCOPE RESET — see scoped-screen-state.test.ts
  useEffect(() => {
    // Cleared synchronously, BEFORE the async load below — the same rule
    // `DaemonIndexPage` states for its rows ("leaving the previous
    // workspace's rows visible during the switch lets a click pair the new
    // workspace id with an old workspace's path") and `VersionTimeline` for
    // its versions. Unconditional, because a switch from one document to
    // another is the case that was missing: the `cancelled` guard below stops
    // a stale load from LANDING, and does nothing about what is still held
    // while the next one is in flight.
    //
    // `hostRef` is the half that matters. `setBody` writes through it and
    // returns early when it is null, while `scheduleSave` keys its scheduler
    // on the NEW id — so without this, a keystroke during the next document's
    // load is written into the previous document and queued under a name that
    // is not its own. Measured: typing under c2 while c2 loaded produced
    // `save('c1', …)`.
    hostRef.current = null
    setDoc(null)
    setBodyState(null)
    setCoreMetaState(null)
    // The rail too: it is document-scoped like everything else here, and
    // left standing it lists the previous document's conversations beside
    // this one's body — with a reply box that would write into whichever
    // document holds the thread it names.
    setAnnotations(NO_ANNOTATIONS)
    // The indicator too. It reads `saved at 10:00` about the document that
    // left, and left standing that becomes a claim about this one, which was
    // never saved at all. Back to the initial value — no unsaved edits, no
    // save yet this session — which is what a freshly loaded document is.
    setSaveState(INITIAL_SAVE_STATE)
    if (!enabled || documentId === null) return
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    void Promise.resolve(pending.get(documentId))
      .catch(() => {})
      .then(async () => {
        const workspaceHost = await openWorkspaceHost(documentId)
        return workspaceHost ?? openLegacyHost(loroRef.current, documentId)
      })
      .then((host) => {
        if (cancelled) return
        hostRef.current = host
        const { containers } = host
        // Guarded rather than left to throw: this runs inside the doc
        // subscription below, where an exception would take the body's own
        // refresh and the save schedule down with it — a document whose
        // annotation layer cannot be read must still open and still save.
        const publishAnnotations = (): void => {
          let next: readonly CommentThread[]
          try {
            next = readAnnotations(containers)
          } catch (err) {
            log.warn('reading annotations failed', err)
            return
          }
          // The subscription fires on every keystroke in the body, so
          // without this the rail is handed a fresh array per character.
          setAnnotations((current) => (sameAnnotations(current, next) ? current : next))
        }
        // Subscribed AFTER the initial import, so loading never schedules a
        // save of what was just loaded. This is how commits made OUTSIDE
        // setBody — a CRDT binding mutating the 'body' container directly —
        // still reach the body state (and the preview) and get persisted.
        unsubscribe = host.doc.subscribe((event) => {
          if (cancelled) return
          setBodyState(readMarkdownBody(containers))
          setCoreMetaState(readCoreFacets(containers) ?? DEFAULT_MARKDOWN_CORE_FACETS)
          // Last, so a failure here cannot cost the refresh above.
          publishAnnotations()
          if (event.by === 'local') scheduleSaveRef.current?.()
        })
        setDoc(host.doc)
        // A document written before the writers were unified stores its body
        // as a text NODE, and reading it is not enough: `LoroSyncPlugin`
        // syncs the text CONTAINER into CodeMirror on mount and overwrites
        // whatever `value` put there, so such a document settles on an empty
        // editor beside a preview showing its prose — and the next keystroke
        // saves over the original. Converting on load is what ends that.
        //
        // Here rather than in a migration pass because this is the moment the
        // document is in memory anyway, and it is a no-op for every document
        // already in the current shape. The write commits locally, so the
        // subscription above both refreshes the state and persists it.
        const stored = readMarkdownBody(containers)
        if (stored.length > 0 && containers.getText(MARKDOWN_BODY_KEY).length === 0) {
          writeMarkdownBody(containers, stored)
        }
        setBodyState(readMarkdownBody(containers))
        setCoreMetaState(readCoreFacets(containers) ?? DEFAULT_MARKDOWN_CORE_FACETS)
        publishAnnotations()
      })
    return () => {
      cancelled = true
      unsubscribe?.()
      // FLUSH, not cancel. A pending debounce holds edits that are already in
      // the document and already on screen; dropping it loses whatever was
      // typed in the last 500ms before a canvas switch or unmount. For the
      // title that is worse than lost text: `renameDocument` writes the
      // snapshot name immediately, so a cancelled facet save leaves the list
      // name and the OKF title disagreeing about what the document is called.
      // Reports like any other write. The component is going away, so
      // nothing renders the result — but this shares the queue with the next
      // load, and a silent branch here is how the two call sites drift apart.
      if (documentId !== null) schedulerRef.current?.scheduler.flush()
    }
  }, [documentId, enabled])

  // One timer for both writers: they persist the same document, so a second
  // independent debounce would only duplicate the save. Reached through a
  // ref from the doc subscription, which is created inside the load effect
  // before this binding initializes on the first render.
  const scheduleSaveRef = useRef<(() => void) | null>(null)
  // Created per document rather than in an effect: the load effect's cleanup
  // has to be able to FLUSH it, and effect cleanups run in reverse order —
  // an effect owning the scheduler could be torn down first.
  const schedulerRef = useRef<{ id: string; scheduler: SaveScheduler } | null>(null)
  const schedulerFor = useCallback((id: string): SaveScheduler => {
    if (schedulerRef.current?.id !== id) {
      schedulerRef.current = {
        id,
        scheduler: createSaveScheduler({
          debounceMs: SAVE_DEBOUNCE_MS,
          now: () => new Date().toISOString(),
          report: (update) => {
            // The switch FLUSHES this document's debounce on purpose, so the
            // last 500ms of typing is not lost — and that write reports after
            // the hook has moved on. `saved` arriving then is a durability
            // claim about the document now on screen, whose own edit may
            // still be sitting in its debounce; `degraded` accuses it of a
            // failure that was not its. Both answer about a document nobody
            // is looking at, so they stop here. The write itself still
            // completes; only its report is scoped.
            if (currentDocumentIdRef.current !== id) return
            setSaveStateRef.current(update)
          },
          // Bound here, so the write goes through the handle this document
          // had when the debounce elapsed — not whatever the next load has
          // put in the ref by the time the queue reaches it.
          beginSave: () => {
            const host = hostRef.current
            return host === null ? null : () => host.save()
          },
          enqueue: (save) => {
            void queueSave(id, save)
          },
          setTimer: (fire, ms) => setTimeout(fire, ms),
          clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
        }),
      }
    }
    return schedulerRef.current.scheduler
  }, [])

  const scheduleSave = useCallback(() => {
    if (documentId === null) return
    schedulerFor(documentId).edit()
  }, [documentId, schedulerFor])
  scheduleSaveRef.current = scheduleSave

  const setBody = useCallback(
    (next: string) => {
      const host = hostRef.current
      if (host === null) return
      setBodyState(next)
      // Replace-wholesale is deliberate for slice 1: the editor is a plain
      // textarea, so we do not have edit deltas to splice. CRDT-granular
      // updates arrive with the collaborative-editor slice.
      writeMarkdownBody(host.containers, next)
      scheduleSave()
    },
    [scheduleSave],
  )

  const setCoreFacets = useCallback(
    (next: StoredCoreFacets) => {
      const host = hostRef.current
      if (host === null) return
      setCoreMetaState(next)
      // `writeCoreFacets` replaces the stored bucket outright, so `next` must
      // already be the complete meta — including `facetsRaw`. DocumentProperties
      // is what guarantees that; this hook does not re-merge.
      writeCoreFacets(host.containers, next)
      scheduleSave()
    },
    [scheduleSave],
  )

  const replyToThread = useCallback((threadId: string, message: CommentMessage) => {
    const host = hostRef.current
    if (host === null) return
    writeThreadMessage(host.containers, threadId, message)
  }, [])

  const bodyTextOf = useCallback(
    (target: Loro): LoroText => {
      const host = hostRef.current
      if (host !== null && host.mode === 'workspace' && documentId !== null) {
        return documentContainers(target, documentId).getText(MARKDOWN_BODY_KEY)
      }
      return target.getText(MARKDOWN_BODY_KEY)
    },
    [documentId],
  )

  return {
    body,
    setBody,
    saveState,
    coreFacets,
    setCoreFacets,
    doc,
    bodyTextOf,
    annotations,
    replyToThread,
  }
}
