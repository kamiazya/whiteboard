// Shared utilities for *.docs-snapshot.test.tsx files. Each snapshot test
// renders a real component with deterministic mocked data and writes its
// PNG straight to docs/assets/, so the source-of-truth image lives next
// to the markdown that embeds it.
//
// __DOCS_ASSETS_DIR__ is inlined at build time by the vitest define block
// in vitest.docs-snapshots.config.ts (node:path is not available inside
// the browser-mode test bundle).

import { waitFor } from '@testing-library/react'
import { page } from 'vitest/browser'

declare const __DOCS_ASSETS_DIR__: string

export function resolveDocAssetPath(name: `${string}.png`): string {
  return `${__DOCS_ASSETS_DIR__}/${name}`
}

export function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

export type DocFetchHandler = (
  url: string,
  init?: RequestInit,
) => Promise<Response> | undefined | Response

// Replace Math.random with a deterministic seeded PRNG (mulberry32) for
// the duration of a snapshot test, so any component that reaches for
// Math.random for an id or a display detail stays byte-stable across
// regenerations.
//
// Returns a restore function the caller installs in afterEach.
export function seedMathRandom(seed = 0xc0ffee): () => void {
  const original = Math.random
  let state = seed >>> 0
  Math.random = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return () => {
    Math.random = original
  }
}

// The WorkspaceTopBar fetches its display names, dirty flag, and branch list
// from three independent endpoints. Snapshot tests that mount the top bar
// share this handler so every card renders the same chrome; `dirty` is the
// only detail a caller varies.
export function topBarFetchHandler({ dirty }: { dirty: boolean }): DocFetchHandler {
  return (url) => {
    if (url.endsWith('/names')) {
      return jsonResponse({
        workspace: 'Main workspace',
        documents: { 'design/architecture': 'System architecture' },
        pinned: [],
      })
    }
    if (url.endsWith('/dirty')) return jsonResponse({ dirty })
    if (url.endsWith('/branches'))
      return jsonResponse({ head: 'main', branches: [{ name: 'main' }] })
    // Catch-all for any unrelated TopBar fetch, so it resolves instead of
    // surfacing an error state in the captured UI.
    return jsonResponse({})
  }
}

// Wait until every independent async chain feeding the screenshot has
// settled. Waiting on one of them alone lets the others' later-settling
// content shift layout after the capture, producing a byte-unstable PNG.
export async function waitForSnapshotContent(
  container: HTMLElement,
  { sceneText, topBarTitle }: { sceneText: string; topBarTitle?: string },
): Promise<void> {
  await waitFor(() => {
    if (topBarTitle !== undefined) {
      // The DOCUMENT name the caller's titleSlot renders — the bar stopped
      // drawing a workspace name of its own when the title moved into the
      // slot, and waiting on the retired text failed every capture. The
      // name still arrives through /names, so this wait still proves that
      // chain settled.
      if (!(container.textContent ?? '').includes(topBarTitle)) {
        throw new Error('TopBar title not yet rendered')
      }
      if (!container.querySelector('[aria-label^="Switch variation"]')) {
        throw new Error('HeaderBranchChip not yet rendered')
      }
    }
    const svgs = container.querySelectorAll('svg')
    // CanvasViewer's SVG is always the last one in document order — icon
    // svgs (WorkspaceTopBar chevrons, kebab menus, etc.) render ahead of it.
    const svg = svgs[svgs.length - 1]
    if (!svg || !(svg.textContent ?? '').includes(sceneText)) {
      throw new Error('scene content not yet rendered')
    }
  })
}

// Screenshot the element carrying `testId` straight to its canonical
// docs/assets/ path.
export async function captureDocAsset(
  container: HTMLElement,
  testId: string,
  fileName: `${string}.png`,
): Promise<void> {
  const target = container.querySelector(`[data-testid="${testId}"]`)
  if (!(target instanceof HTMLElement)) {
    throw new Error(`docs-snapshot: no element with data-testid="${testId}"`)
  }
  await page.screenshot({
    path: resolveDocAssetPath(fileName),
    element: page.elementLocator(target),
  })
}

// Adapt a (url, init) → Response handler to fetch's signature, and reject
// loudly on unhandled URLs so a missing mock fails the test instead of
// silently stalling on a network error.
export function makeFetchMock(handler: DocFetchHandler) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const result = handler(url, init)
    if (result instanceof Promise) return result
    if (result instanceof Response) return result
    throw new Error(`docs-snapshot: unhandled fetch ${init?.method ?? 'GET'} ${url}`)
  }
}
