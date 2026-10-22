import { SYNC_TEXT_BREACH_CODES, type SyncTextBreach } from '@kamiazya/whiteboard-loro-adapter'
import {
  ANCHOR_NODES_LIMIT_PHRASE,
  annotationAnchorInputSchema,
  CANVAS_EDGES_AND_LINES_LIMIT_PHRASE,
  CANVAS_MAX_EDGES_AND_LINES,
  CANVAS_MAX_NODES,
  CANVAS_NODES_LIMIT_PHRASE,
  COMMENT_MESSAGE_LIMIT_PHRASE,
  COMMENT_MESSAGE_MAX_CHARS,
  CONTAINER_NAME_LIMIT_PHRASE,
  CONTAINER_NAME_MAX_CHARS,
  commentMessageInputSchema,
  DOCUMENT_MAX_OPEN_CHANGES,
  DOCUMENT_MAX_OPEN_THREADS,
  LABEL_LIMIT_PHRASE,
  LABEL_MAX_CHARS,
  labelInputSchema,
  NODE_LOCATION_LIMIT_PHRASE,
  NODE_LOCATION_MAX_CHARS,
  NODE_TEXT_LIMIT_PHRASE,
  NODE_TEXT_MAX_CHARS,
  nodeFileInputSchema,
  nodeTextInputSchema,
  OPEN_CHANGES_LIMIT_PHRASE,
  OPEN_THREADS_LIMIT_PHRASE,
  syncWriteRefusalCodeSchema,
  TAG_COUNT_LIMIT_PHRASE,
  TAG_LENGTH_LIMIT_PHRASE,
  TAG_MAX_CHARS,
  TAGS_PER_ELEMENT_MAX,
  tagListWriteSchema,
  tagWriteSchema,
} from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import type { ZodString } from 'zod'
import { DocumentEngineTrapError } from '../document-io.js'
import * as refusals from './sync-write-refusals.js'
import {
  CausalGapError,
  DocumentKindChangedError,
  DocumentNameTooLongError,
  OffGrammarPathError,
  RootNoDocumentHoldsError,
  type SyncWriteRefusalError,
  syncWriteAnswer,
  TooManyDocumentsError,
  TooManyFoldersError,
  textBreachRefusal,
  UnreadableDocumentMetaError,
} from './sync-write-refusals.js'

const MAP = 'cid:0@1:Map'

/** One instance of each refusal class the module exports, keyed by class name. */
const SAMPLES: Readonly<Record<string, () => SyncWriteRefusalError>> = {
  OffGrammarPathError: () => new OffGrammarPathError(['Meeting notes']),
  UnreadableDocumentMetaError: () => new UnreadableDocumentMetaError(['0@1']),
  RootNoDocumentHoldsError: () => new RootNoDocumentHoldsError(['nameChosen']),
  DocumentNameTooLongError: () => new DocumentNameTooLongError(['notes']),
  TooManyDocumentsError: () => new TooManyDocumentsError(2001),
  TooManyFoldersError: () => new TooManyFoldersError(4001),
  CausalGapError: () => new CausalGapError(),
  DocumentKindChangedError: () =>
    new DocumentKindChangedError('spatial', 'markdown', '01BRWAAAAAAAAAAAAAAAAAAAB0'),
}

/**
 * One text refusal per breach shape, built the one way any is. Keyed by the
 * table both keepers answer from, so a shape added there without a sample
 * here fails to compile.
 */
const TEXT_SAMPLES: Readonly<Record<SyncTextBreach['shape'], () => SyncWriteRefusalError>> = {
  run: () => textBreachRefusal({ shape: 'run', chars: 300_000, container: MAP }),
  runs: () => textBreachRefusal({ shape: 'runs', chars: 400_000, runs: 2, container: MAP }),
  body: () => textBreachRefusal({ shape: 'body', chars: 300_000, container: MAP }),
  'node-text': () =>
    textBreachRefusal({ shape: 'node-text', chars: 9_000, nodeId: 'n1', container: MAP }),
  'node-location': () =>
    textBreachRefusal({ shape: 'node-location', chars: 9_000, nodeId: 'n1', container: MAP }),
  label: () => textBreachRefusal({ shape: 'label', chars: 2_000, elementId: 'e1', container: MAP }),
  'comment-message': () =>
    textBreachRefusal({ shape: 'comment-message', chars: 5_000, messageId: 'm1', container: MAP }),
  tags: () =>
    textBreachRefusal({
      shape: 'tags',
      measure: 'chars',
      amount: 2_000,
      elementId: 'n1',
      container: MAP,
    }),
  'container-name': () =>
    textBreachRefusal({ shape: 'container-name', chars: 70_000, container: MAP }),
  'canvas-size': () =>
    textBreachRefusal({ shape: 'canvas-size', measure: 'nodes', count: 2_001, container: MAP }),
  'thread-anchor': () =>
    textBreachRefusal({ shape: 'thread-anchor', count: 2_001, threadId: 't1', container: MAP }),
  'anchor-quote': () =>
    textBreachRefusal({ shape: 'anchor-quote', chars: 2_000, elementId: 't1', container: MAP }),
  'open-threads': () => textBreachRefusal({ shape: 'open-threads', count: 501, container: MAP }),
  'open-changes': () => textBreachRefusal({ shape: 'open-changes', count: 1_001, container: MAP }),
  'content-root': () => textBreachRefusal({ shape: 'content-root', key: 'nodes', container: MAP }),
  'unattached-container': () =>
    textBreachRefusal({ shape: 'unattached-container', container: MAP }),
}

const ALL_SAMPLES = [...Object.values(SAMPLES), ...Object.values(TEXT_SAMPLES)]

/**
 * Text-breach classes answering a refusal another class already gives: the
 * workspace record's judge finds, as an operation, what the per-document
 * route finds as a root — a content key of the wrong kind — and a write into
 * a container it does not build on is a change sent before what it builds on.
 */
const SAME_ANSWER_AS: Readonly<Record<string, string>> = {
  ContentRootKindError: 'RootNoDocumentHoldsError',
  UnattachedContainerError: 'CausalGapError',
}

/** Each text breach's status where it is not 413, the bound on how much. */
const TEXT_STATUS: Partial<Record<SyncTextBreach['shape'], number>> = {
  'content-root': 400,
  'unattached-container': 409,
}

/** The concrete error classes the module exports, found rather than listed. */
const declared = Object.entries(refusals)
  .filter(
    ([, value]) =>
      typeof value === 'function' &&
      value.prototype instanceof Error &&
      value !== refusals.SyncWriteRefusalError &&
      value !== refusals.TextBreachRefusalError,
  )
  .map(([name]) => name)

describe('syncWriteAnswer', () => {
  it('finds the refusal classes it judges', () => {
    expect(declared.length).toBeGreaterThanOrEqual(3)
  })

  it('has a sample for every refusal class the module declares', () => {
    // A refusal class added without one fails here, before a route answers it 500.
    expect([...declared].sort()).toEqual(Object.keys(SAMPLES).sort())
  })

  it('answers each refusal with its own code and a client-error status', () => {
    const codeOf = new Map<string, unknown>()
    for (const sample of ALL_SAMPLES) {
      const refusal = sample()
      const answer = syncWriteAnswer(refusal)
      expect(answer?.status).toBeGreaterThanOrEqual(400)
      expect(answer?.status).toBeLessThan(500)
      codeOf.set(refusal.name, answer?.code)
    }
    // One code per class: a run and a body are one class, a body too large.
    // A class sharing a code is one answer reached from a second surface, and
    // says which class it answers as.
    for (const [shared, as] of Object.entries(SAME_ANSWER_AS)) {
      expect(codeOf.get(shared)).toBe(codeOf.get(as))
      codeOf.delete(shared)
    }
    expect(new Set(codeOf.values()).size).toBe(codeOf.size)
  })

  it('answers each text breach with the code the shared table gives it', () => {
    for (const [shape, sample] of Object.entries(TEXT_SAMPLES)) {
      expect(syncWriteAnswer(sample())).toEqual({
        code: SYNC_TEXT_BREACH_CODES[shape as SyncTextBreach['shape']],
        status: TEXT_STATUS[shape as SyncTextBreach['shape']] ?? 413,
      })
    }
  })

  it('answers with exactly the codes the shared vocabulary declares', () => {
    // The client parses a refusal by that vocabulary: a code it does not list
    // reaches the person as "the keeper did not say why", and one listed but
    // never answered is copy nobody reads.
    const codes = new Set(ALL_SAMPLES.map((sample) => syncWriteAnswer(sample())?.code))
    expect([...codes].sort()).toEqual([...syncWriteRefusalCodeSchema.options].sort())
  })

  it('answers an engine trap as the server fault /api/v1 names it', () => {
    expect(
      syncWriteAnswer(new DocumentEngineTrapError('document d', 'importing an update into', null)),
    ).toEqual({ code: 'document_engine_trap', status: 500 })
  })

  it('answers nothing else', () => {
    expect(syncWriteAnswer(new Error('anything'))).toBeUndefined()
  })
})

describe('a refused text bound', () => {
  // A sync write and a tool write past the same bound tell the writer the
  // same limit and the same way out, whichever path refused it.
  it.each([
    [
      'node text',
      TEXT_SAMPLES['node-text'],
      NODE_TEXT_LIMIT_PHRASE,
      nodeTextInputSchema,
      NODE_TEXT_MAX_CHARS,
    ],
    [
      'a location',
      TEXT_SAMPLES['node-location'],
      NODE_LOCATION_LIMIT_PHRASE,
      nodeFileInputSchema,
      NODE_LOCATION_MAX_CHARS,
    ],
    ['a label', TEXT_SAMPLES.label, LABEL_LIMIT_PHRASE, labelInputSchema, LABEL_MAX_CHARS],
    [
      'a comment message',
      TEXT_SAMPLES['comment-message'],
      COMMENT_MESSAGE_LIMIT_PHRASE,
      commentMessageInputSchema,
      COMMENT_MESSAGE_MAX_CHARS,
    ],
    ['a tag', TEXT_SAMPLES.tags, TAG_LENGTH_LIMIT_PHRASE, tagWriteSchema, TAG_MAX_CHARS],
  ] as const)('ends %s as the tools do', (_, sample, phrase, schema: ZodString, max) => {
    // The whole tail, so a refusal that adds its own qualifier after the bound fails.
    const tail = (text: string | undefined, clause: string) => text?.slice(-clause.length)
    const syncRefusal = sample?.().message
    expect(tail(syncRefusal, `, past ${phrase}`)).toBe(`, past ${phrase}`)
    const toolRefusal = schema.safeParse('x'.repeat(max + 1)).error?.issues[0]?.message
    expect(tail(toolRefusal, ` is longer than ${phrase}`)).toBe(` is longer than ${phrase}`)
  })
})

describe('a refused comment anchor', () => {
  it('names the thread, and ends on the node-set bound as the tool input does', () => {
    expect(TEXT_SAMPLES['thread-anchor']().message).toBe(
      `This update would leave comment thread "t1" anchored to 2001 nodes, past ${ANCHOR_NODES_LIMIT_PHRASE}`,
    )
    const tool = annotationAnchorInputSchema.safeParse({
      kind: 'spatial',
      nodeIds: Array.from({ length: CANVAS_MAX_NODES + 1 }, (_, i) => `n${i}`),
      x: 0,
      y: 0,
    }).error?.issues[0]?.message
    expect(tool?.endsWith(ANCHOR_NODES_LIMIT_PHRASE)).toBe(true)
  })
})

describe('a refused tag count', () => {
  it('names the board, or the element, and ends on the count bound as the tools do', () => {
    const refusal = (elementId: string | null) =>
      textBreachRefusal({
        shape: 'tags',
        measure: 'count',
        amount: TAGS_PER_ELEMENT_MAX + 1,
        elementId,
        container: MAP,
      }).message
    expect(refusal(null)).toBe(
      `This update would give the board ${TAGS_PER_ELEMENT_MAX + 1} tags, past ${TAG_COUNT_LIMIT_PHRASE}`,
    )
    expect(refusal('n1')).toContain('element "n1"')
    const tool = tagListWriteSchema.safeParse(Array(TAGS_PER_ELEMENT_MAX + 1).fill('t')).error
      ?.issues[0]?.message
    expect(tool?.endsWith(TAG_COUNT_LIMIT_PHRASE)).toBe(true)
  })

  it('names the document holding it, once resolved', () => {
    const refusal = textBreachRefusal(
      { shape: 'tags', measure: 'count', amount: 2_000, elementId: 'e1', container: MAP },
      { path: 'boards/ops' },
    )
    expect(refusal.message).toBe(
      `The document at "boards/ops" gives element "e1" 2000 tags, past ${TAG_COUNT_LIMIT_PHRASE}`,
    )
  })
})

describe('a refused run found in a resolved document', () => {
  // A run lives in the history, so the body a person opens may be short; the
  // refusal says how long it is today only when the caller measured it.
  const run = (at: refusals.RefusedIn) =>
    textBreachRefusal({ shape: 'run', chars: 300_000, container: MAP }, at).message

  it('says how long the body is now when the caller measured it', () => {
    expect(run({ path: 'notes/a', bodyChars: 12 })).toContain(
      ', though its body is 12 characters now',
    )
  })

  it('says nothing of the body today when the caller did not measure it', () => {
    expect(run({ path: 'notes/a' })).not.toContain('though its body is')
  })
})

describe('a refused container name', () => {
  const refusal = (at?: refusals.RefusedIn) =>
    textBreachRefusal(
      { shape: 'container-name', chars: CONTAINER_NAME_MAX_CHARS + 1, container: MAP },
      at,
    ).message

  it('says how long the name is and ends on the bound, never quoting the name', () => {
    expect(refusal()).toBe(
      `This update would bring in a container named with ${CONTAINER_NAME_MAX_CHARS + 1} characters, past ${CONTAINER_NAME_LIMIT_PHRASE}`,
    )
  })

  it('names the document holding it, once resolved', () => {
    expect(refusal({ path: 'boards/ops' })).toBe(
      `The document at "boards/ops" holds a container named with ${CONTAINER_NAME_MAX_CHARS + 1} characters, past ${CONTAINER_NAME_LIMIT_PHRASE}`,
    )
  })
})

describe('a refused canvas size', () => {
  const refusal = (measure: 'nodes' | 'edges-and-lines', count: number, at?: refusals.RefusedIn) =>
    textBreachRefusal({ shape: 'canvas-size', measure, count, container: MAP }, at).message

  it('says how large the board would be and ends on the bound the tool holds', () => {
    expect(refusal('nodes', CANVAS_MAX_NODES + 1)).toBe(
      `This update would leave a canvas of ${CANVAS_MAX_NODES + 1} nodes, past ${CANVAS_NODES_LIMIT_PHRASE}`,
    )
    expect(refusal('edges-and-lines', CANVAS_MAX_EDGES_AND_LINES + 1)).toBe(
      `This update would leave a canvas of ${CANVAS_MAX_EDGES_AND_LINES + 1} edges and lines, past ${CANVAS_EDGES_AND_LINES_LIMIT_PHRASE}`,
    )
  })

  it('names the document holding it, once resolved', () => {
    expect(refusal('nodes', 2_500, { path: 'boards/ops' })).toBe(
      `The document at "boards/ops" is a canvas of 2500 nodes, past ${CANVAS_NODES_LIMIT_PHRASE}`,
    )
  })
})

describe('a refused count of open annotations', () => {
  const refusal = (
    shape: 'open-threads' | 'open-changes',
    count: number,
    at?: refusals.RefusedIn,
  ) => textBreachRefusal({ shape, count, container: MAP }, at).message

  it('says how many would be open and ends on the bound the tools hold', () => {
    expect(refusal('open-threads', DOCUMENT_MAX_OPEN_THREADS + 1)).toBe(
      `This update would leave ${DOCUMENT_MAX_OPEN_THREADS + 1} open comment threads on a document, past ${OPEN_THREADS_LIMIT_PHRASE}`,
    )
    expect(refusal('open-changes', DOCUMENT_MAX_OPEN_CHANGES + 1)).toBe(
      `This update would leave ${DOCUMENT_MAX_OPEN_CHANGES + 1} open proposed changes on a document, past ${OPEN_CHANGES_LIMIT_PHRASE}`,
    )
  })

  it('names the document holding them, once resolved', () => {
    expect(refusal('open-threads', 600, { path: 'boards/ops' })).toBe(
      `The document at "boards/ops" holds 600 open comment threads, past ${OPEN_THREADS_LIMIT_PHRASE}`,
    )
  })
})
