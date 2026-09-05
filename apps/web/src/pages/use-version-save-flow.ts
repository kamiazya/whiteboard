/**
 * The save-a-version race guard, shared by the browser and daemon document
 * pages (previously duplicated between them, guard-for-guard).
 *
 * A document page keeps its own document switching rather than remounting
 * (App.tsx says so at the mount site), so a save that started on one
 * document can settle after another is already on screen. `scopeRef` names
 * whatever the page's document identity currently is —
 * `currentDocumentIdRef` on the browser page, `currentDocumentPathRef` on
 * the daemon page — read fresh on every settle rather than captured once,
 * because the page's own effect keeps it current across the switch this
 * guard is defending against.
 *
 * `save` performs the actual write and resolves to a COMMIT THUNK: the
 * post-save announce work (thumbnail attach, event dispatch) that must run
 * only while the save's own document is still the one on screen. Returning
 * it instead of running it inline is what keeps the outcome applied before
 * that work runs, and skipped along with it after a switch — flattening the
 * contract into a plain `Promise<void>` loses both.
 */

import type { RefObject } from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { SaveVersionOutcome } from '../components/workspace-top-bar/BookmarkAction.js'

export interface VersionSaveFlow {
  readonly saving: boolean
  readonly outcome: SaveVersionOutcome
  readonly run: (label: string) => Promise<void>
}

export function useVersionSaveFlow<Scope>(
  scopeRef: RefObject<Scope>,
  scopeKey: unknown,
  save: (label: string) => Promise<() => void>,
): VersionSaveFlow {
  // Names kept as `savingVersion`/`saveVersionOutcome` (not the shorter
  // `saving`/`outcome`) because scoped-screen-state.test.ts's source scan
  // keys its BrowserDocumentPage ledger on these identifiers — renaming
  // them here would silently stop the scan from finding the state it moved.
  const [savingVersion, setSavingVersion] = useState(false)
  const [saveVersionOutcome, setSaveVersionOutcome] = useState<SaveVersionOutcome>(null)

  const run = useCallback(
    async (label: string): Promise<void> => {
      if (savingVersion) return
      // The document this run is about, fixed before the first await. A
      // switch mid-save must not report itself under the arrived document.
      const startedOn = scopeRef.current
      setSavingVersion(true)
      setSaveVersionOutcome(null)
      try {
        const commit = await save(label)
        if (scopeRef.current !== startedOn) return
        setSaveVersionOutcome('saved')
        commit()
      } catch {
        if (scopeRef.current !== startedOn) return
        setSaveVersionOutcome('failed')
      } finally {
        // Verbatim: after a genuine switch mid-save, `saving` stays true —
        // this bail is intentional, not an oversight to "fix" in passing.
        if (scopeRef.current === startedOn) setSavingVersion(false)
      }
    },
    [savingVersion, save, scopeRef],
  )

  // SCOPE RESET — owned HERE, keyed on the page's document identity, not
  // delegated to each page's hand-written reset effect. The daemon page
  // shipped without the clear, and a 'saved' badge earned on one document
  // stayed lit under the next — a hook that owns its own reset makes that
  // omission impossible for the next page too.
  useEffect(() => {
    setSaveVersionOutcome(null)
  }, [scopeKey])

  return { saving: savingVersion, outcome: saveVersionOutcome, run }
}
