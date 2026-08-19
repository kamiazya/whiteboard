/**
 * What a `[[reference]]` survives, measured rather than assumed.
 *
 * Nothing rewrites a reference when a document moves or is renamed — there
 * is no backlink index and no rewriting pass anywhere. Whichever identifier
 * the author wrote has to keep being true, and the three accepted forms fail
 * in complementary ways:
 *
 *   | written as   | path move | display-name change |
 *   |--------------|-----------|---------------------|
 *   | the path     | breaks    | survives            |
 *   | the name     | survives  | breaks              |
 *   | the id       | survives  | survives            |
 *
 * This is the contract, not a defect list: `daemonLinkEntries` accepts both
 * human forms on purpose, because both are identifiers a reader would type.
 * The table is here so a change to either resolver has to state which column
 * it is moving, and so anyone adding a move affordance knows what it costs.
 */

import { parseMarkdownBody, resolveReferences } from '@kamiazya/whiteboard-codec'
import type { DocumentSummary } from '@kamiazya/whiteboard-mcp/api-contracts'
import { describe, expect, it } from 'vitest'
import { createSnapshotAliasResolver } from '../components/markdown-editor/alias-resolver.js'
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
    createSnapshotAliasResolver(daemonLinkEntries(docs)),
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
  it('all three forms resolve while nothing has changed', () => {
    expect(resolvedCount('[[design/login]]', HERE)).toBe(1)
    expect(resolvedCount('[[Login flow]]', HERE)).toBe(1)
    expect(resolvedCount(`[[${ID}]]`, HERE)).toBe(1)
  })

  // The cost of a move affordance: every reference someone wrote as a path
  // goes back to being literal bracket text, silently.
  it('a reference written as the path does not survive a move', () => {
    expect(resolvedCount('[[design/login]]', MOVED)).toBe(0)
    expect(resolvedCount('[[design/login]]', RENAMED)).toBe(1)
  })

  // And the complementary half, which is why dropping the path form would
  // not be a fix — it would trade one breakage for a more frequent one.
  it('a reference written as the display name does not survive a rename', () => {
    expect(resolvedCount('[[Login flow]]', RENAMED)).toBe(0)
    expect(resolvedCount('[[Login flow]]', MOVED)).toBe(1)
  })

  it('a reference written as the id survives both', () => {
    expect(resolvedCount(`[[${ID}]]`, MOVED)).toBe(1)
    expect(resolvedCount(`[[${ID}]]`, RENAMED)).toBe(1)
  })
})
