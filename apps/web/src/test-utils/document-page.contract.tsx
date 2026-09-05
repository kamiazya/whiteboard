/**
 * The document page's behaviour, written once and run against BOTH keepers.
 *
 * `DocumentPage` renders one body from whatever `DocumentKeeper` answers, so
 * a scenario about that body is a scenario both keepers must pass — and one
 * written against only one of them is the gap `keeper-parity.test.ts`
 * exists to name: the daemon page shipped the editor's file seams while the
 * same page in browser mode passed none of them, and every suite stayed
 * green, because the missing test is an ABSENT test rather than a failing
 * one. Same shape as `lib/versions-backend.contract.ts`, one level up.
 *
 * Each keeper supplies a fixture: how to mount the page open on a set of
 * documents, what label its picker gives a document (the browser carries a
 * display name; the daemon summary does not, so the path stands in), and how
 * to observe that the page opened another document (a route on the browser,
 * a new backend on the daemon). The scenarios below never mention a keeper.
 */
import { act, cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { THEME_STORAGE_KEY } from '../hooks/useThemeMode.js'
import { defaultUserSettings, STORAGE_KEY } from '../lib/user-settings-store.js'
import { webMcpTools } from '../lib/webmcp/tool-definitions.js'
import type { ModelContext, WebMcpToolDescriptor } from '../lib/webmcp/use-browser-tool-registry.js'
import {
  capturedEditorProps,
  latestEditorProps,
  resetCapturedEditorProps,
} from './capturing-spatial-editor.js'

export interface ContractDocument {
  readonly id: string
  readonly path: string
  readonly name: string
  readonly kind: 'spatial' | 'markdown'
}

export interface DocumentPageFixture {
  readonly keeper: 'browser' | 'daemon'
  /**
   * Mounts the page open on `documents[0]`, with the rest listed beside it,
   * and resolves once the (captured) spatial editor is on screen.
   */
  mount(documents: readonly ContractDocument[]): Promise<void>
  /** What the picker calls `doc`: its name where the keeper carries one, else its path. */
  labelOf(doc: ContractDocument): string
  /** Resolves once the page has opened the document at `path`, however this keeper does that. */
  expectOpened(path: string): Promise<void>
}

/** Two documents, with a path, an id and a name that could never stand in for one another. */
export const HERE: ContractDocument = {
  id: '005AFMSY38DJQW16BGNTZ49EKR',
  path: 'here',
  name: 'Here',
  kind: 'spatial',
}
export const TARGET: ContractDocument = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  path: 'archive/target',
  name: 'Target',
  kind: 'spatial',
}

function createFakeModelContext(): ModelContext & { liveNames(): string[] } {
  const live = new Map<string, AbortSignal>()
  return {
    liveNames: () => [...live.keys()],
    registerTool: async (descriptor: WebMcpToolDescriptor, options: { signal: AbortSignal }) => {
      await Promise.resolve()
      if (options.signal.aborted) return
      live.set(descriptor.name, options.signal)
      options.signal.addEventListener('abort', () => live.delete(descriptor.name))
    },
  }
}

/** Two microtask turns: the registry's own `await` before it records a tool. */
async function settleRegistrations(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

export function describeDocumentPageContract(fixture: DocumentPageFixture): void {
  describe(`document page, ${fixture.keeper} keeper`, () => {
    beforeEach(() => {
      resetCapturedEditorProps()
      window.localStorage.clear()
    })
    afterEach(() => {
      cleanup()
      window.localStorage.clear()
      delete (document as { modelContext?: unknown }).modelContext
    })

    // The `theme` prop is optional, so a page that forgets to pass it still
    // compiles — silently reproducing the dark-mode-invisible-chrome bug this
    // wiring exists to fix.
    describe('theme', () => {
      it('threads a stored dark preference into the spatial editor', async () => {
        window.localStorage.setItem(THEME_STORAGE_KEY, 'dark')
        await fixture.mount([HERE])
        expect(capturedEditorProps.map((p) => p.theme)).toContain('dark')
      })

      it('threads a stored light preference, and never dark', async () => {
        window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
        await fixture.mount([HERE])
        const themes = capturedEditorProps.map((p) => p.theme)
        expect(themes).toContain('light')
        expect(themes).not.toContain('dark')
      })
    })

    describe('WebMCP', () => {
      it('registers every read-only tool once the document is on screen', async () => {
        const fake = createFakeModelContext()
        document.modelContext = fake
        await fixture.mount([HERE])
        await settleRegistrations()
        expect(fake.liveNames().sort()).toEqual(webMcpTools.map((tool) => tool.name).sort())
      })

      it('registers no tools when capabilities.webMcpEnabled is persisted as false', async () => {
        window.localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ ...defaultUserSettings(), capabilities: { webMcpEnabled: false } }),
        )
        const fake = createFakeModelContext()
        document.modelContext = fake
        await fixture.mount([HERE])
        await settleRegistrations()
        expect(fake.liveNames()).toEqual([])
      })
    })

    // A file node references the target's immutable id (rename- and
    // move-safe, ADR-0008) while everything a person sees stays on paths and
    // names, so the page converts at exactly two points: the options it
    // offers, and the open that resolves an id back to a current path.
    describe('file references', () => {
      it('offers every other document as an id-valued ref under its label', async () => {
        await fixture.mount([HERE, TARGET])
        await waitFor(() =>
          expect(latestEditorProps()?.fileRefOptions?.length ?? 0).toBeGreaterThan(0),
        )
        expect(latestEditorProps()?.fileRefOptions).toEqual([
          { file: TARGET.id, label: fixture.labelOf(TARGET), kind: 'spatial' },
        ])
      })

      it('opens an id ref on that document’s current path', async () => {
        await fixture.mount([HERE, TARGET])
        await waitFor(() =>
          expect(latestEditorProps()?.fileRefOptions?.length ?? 0).toBeGreaterThan(0),
        )
        await act(async () => {
          latestEditorProps()?.onOpenFileRef?.(TARGET.id)
        })
        await fixture.expectOpened(TARGET.path)
      })

      it('marks a ref matching neither a live id nor a live path as missing, sparing image refs', async () => {
        await fixture.mount([HERE, TARGET])
        await waitFor(() => expect(latestEditorProps()?.missingFileRef).toBeDefined())
        const missing = latestEditorProps()?.missingFileRef
        // A live id and a live path (a legacy ref) are both known; a ref
        // matching neither points at a deleted document. Image refs live in
        // the file store, not the documents list, so they are never missing.
        expect(missing?.(TARGET.id)).toBe(false)
        expect(missing?.(TARGET.path)).toBe(false)
        expect(missing?.('deleted-canvas-id')).toBe(true)
        expect(missing?.('asset:0f5bffa1-9d0f-4d2f-a2c4-0f0d4a1a2b3c')).toBe(false)
      })
    })

    // Not vacuous: the fixture's mount promise is what every scenario above
    // waits on, and a mount that resolved on nothing would pass them all.
    it('mounts with the captured spatial editor on screen', async () => {
      await fixture.mount([HERE])
      expect(screen.getByTestId('stub-spatial-editor')).toBeTruthy()
    })
  })
}
