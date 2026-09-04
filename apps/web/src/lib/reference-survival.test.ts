/**
 * What a `[[reference]]` survives AT THE RESOLVER, measured rather than
 * assumed. Since display names were retired from resolution (owner
 * decision, 2026-09-03), the accepted written forms are two:
 *
 *   | written as   | path move | display-name change |
 *   |--------------|-----------|---------------------|
 *   | the path     | breaks    | survives            |
 *   | the id       | survives  | survives            |
 *   | the name     | never resolves — retired         |
 *
 * The path cell's break is repaired one layer up — a move rewrites
 * references written to the old path (codec's `planReferenceRewrite`,
 * applied by the daemon's move route and by `local-files-source`). The
 * repair cannot reach a body edited outside the workspace or pasted back
 * in, so the cell stays true here at the resolver.
 *
 * The name row is the retirement itself: a `[[Name]]` written today stays
 * literal bracket text whatever happens, and the display name reaches the
 * reader at render time instead (`resolveTitle` labeling a bare `[[path]]`).
 */

import {
  createUniqueNameResolver,
  parseMarkdownBody,
  resolveReferences,
} from '@kamiazya/whiteboard-codec'
import type { DocumentSummary } from '@kamiazya/whiteboard-mcp/api-contracts'
import { describe, expect, it } from 'vitest'
import { daemonLinkEntries } from './daemon-link-entries.js'

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

const at = '2026-05-01T12:00:00.000Z'
const listed = (path: string, displayName: string): DocumentSummary[] => [
  { id: ID, path, displayName, updatedAt: at, kind: 'markdown' },
]

/** How many references in `body` resolve against the documents in `docs`. */
function resolvedCount(body: string, docs: readonly DocumentSummary[]): number {
  const root = resolveReferences(
    parseMarkdownBody(body),
    createUniqueNameResolver(daemonLinkEntries(docs)),
  )
  let found = 0
  const walk = (node: { type: string; children?: unknown[] }): void => {
    if (node.type === 'wikiLink' || node.type === 'embed') found += 1
    for (const child of (node.children ?? []) as (typeof node)[]) walk(child)
  }
  walk(root as never)
  return found
}

const HERE = listed('design/login', 'Login flow')
const MOVED = listed('archive/login', 'Login flow')
const RENAMED = listed('design/login', 'Sign-in flow')

describe('what a [[reference]] survives', () => {
  it('both written forms resolve while nothing has changed', () => {
    expect(resolvedCount('[[design/login]]', HERE)).toBe(1)
    expect(resolvedCount(`[[${ID}]]`, HERE)).toBe(1)
  })

  // The cost of a move affordance: every reference someone wrote as a path
  // goes back to being literal bracket text, silently.
  it('a reference written as the path does not survive a move', () => {
    expect(resolvedCount('[[design/login]]', MOVED)).toBe(0)
    expect(resolvedCount('[[design/login]]', RENAMED)).toBe(1)
  })

  // The retired row: a display name never resolves, before or after any
  // rename — the name reaches the reader at render time instead.
  it('a reference written as the display name never resolves', () => {
    expect(resolvedCount('[[Login flow]]', HERE)).toBe(0)
    expect(resolvedCount('[[Login flow]]', RENAMED)).toBe(0)
    expect(resolvedCount('[[Login flow]]', MOVED)).toBe(0)
  })

  it('a reference written as the id survives both', () => {
    expect(resolvedCount(`[[${ID}]]`, MOVED)).toBe(1)
    expect(resolvedCount(`[[${ID}]]`, RENAMED)).toBe(1)
  })
})
