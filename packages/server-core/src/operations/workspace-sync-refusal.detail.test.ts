import type { SyncTextBreach, WorkspaceSyncBreach } from '@kamiazya/whiteboard-loro-adapter'
import { describe, expect, it } from 'vitest'
import { workspaceSyncRefusal } from './workspace-sync-refusal.js'

type Breach = SyncTextBreach | WorkspaceSyncBreach
const CONTAINER = 'cid:root-body:Text' as const

/**
 * One breach per shape either judge answers. A keeper whose record is an
 * engine lease is handed the judge's object as JSON (`Breach.detail`), so the
 * refusal built from it must be the refusal built from the object itself.
 */
const BREACHES = {
  run: { shape: 'run', chars: 600_000, container: CONTAINER },
  runs: { shape: 'runs', chars: 900_000, runs: 3, container: CONTAINER },
  body: { shape: 'body', chars: 700_000, container: CONTAINER },
  'node-text': { shape: 'node-text', chars: 50_000, nodeId: 'n1', container: CONTAINER },
  'node-location': { shape: 'node-location', chars: 5000, nodeId: 'n1', container: CONTAINER },
  label: { shape: 'label', chars: 9000, elementId: 'e1', container: CONTAINER },
  'comment-message': {
    shape: 'comment-message',
    chars: 9000,
    messageId: 'm1',
    container: CONTAINER,
  },
  tags: { shape: 'tags', measure: 'count', amount: 99, elementId: null, container: CONTAINER },
  'thread-anchor': { shape: 'thread-anchor', count: 9999, threadId: 't1', container: CONTAINER },
  'anchor-quote': { shape: 'anchor-quote', chars: 9000, elementId: 't1', container: CONTAINER },
  'container-name': { shape: 'container-name', chars: 900, container: CONTAINER },
  'canvas-size': { shape: 'canvas-size', measure: 'nodes', count: 99_999, container: CONTAINER },
  'open-threads': { shape: 'open-threads', count: 500, container: CONTAINER },
  'open-changes': { shape: 'open-changes', count: 500, container: CONTAINER },
  'thread-messages': { shape: 'thread-messages', count: 500, container: CONTAINER },
  'content-root': { shape: 'content-root', key: 'body', container: CONTAINER },
  'unattached-container': { shape: 'unattached-container', container: CONTAINER },
  'reserved-map-key': { shape: 'reserved-map-key', container: CONTAINER },
  'retired-shape': { shape: 'retired-shape', found: 'x-whiteboard', container: CONTAINER },
  'retired-comment-plane': { shape: 'retired-comment-plane', rows: 2, container: CONTAINER },
  'causal-gap': { shape: 'causal-gap' },
  'too-many-documents': { shape: 'too-many-documents', count: 5001 },
  'too-many-folders': { shape: 'too-many-folders', count: 5001 },
  'unreadable-document-meta': { shape: 'unreadable-document-meta', nodes: ['1@2'] },
  'invalid-path': { shape: 'invalid-path', paths: ['not a segment'] },
  'document-name-too-long': { shape: 'document-name-too-long', paths: ['a'] },
  'folder-name-refused': { shape: 'folder-name-refused', paths: ['a'], reason: 'has a slash' },
  'document-kind-changed': {
    shape: 'document-kind-changed',
    container: CONTAINER,
    recorded: 'markdown',
    kind: undefined,
    documentId: '01BRWAAAAAAAAAAAAAAAAAAAA0',
  },
} as const satisfies Record<Breach['shape'], Breach>

/** What a surface reads off a refusal: its class, code, message and own fields. */
const bodyOf = (error: Error) => ({ ...error, name: error.name, message: error.message })

describe('the refusal built from a breach as the engine carries it', () => {
  it('covers every shape a judge answers', () => {
    expect(Object.keys(BREACHES).length).toBeGreaterThan(25)
  })

  for (const [shape, breach] of Object.entries(BREACHES)) {
    it(`is the refusal built from the judge's own object for ${shape}`, () => {
      const carried = JSON.parse(JSON.stringify(breach)) as Breach
      expect(bodyOf(workspaceSyncRefusal(carried))).toEqual(bodyOf(workspaceSyncRefusal(breach)))
    })
  }
})
