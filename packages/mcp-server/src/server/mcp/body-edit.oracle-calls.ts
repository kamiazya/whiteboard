/**
 * The calls `body-edit.oracle.test.ts` records, by what each one is about:
 * the refusals the tool owns, the writes it answers in both modes, and the
 * arguments the SDK refuses. A refusal changes nothing, so those come first
 * over the notes as they were seeded; the writes follow, each note's own
 * calls in the order its state needs.
 */
import { MARKDOWN_MAX_CHARS } from '@kamiazya/whiteboard-model'

type Message = Record<string, unknown>

const W = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const NOTHING = '01BX5ZZKBKACTAV9WEVGEMMVRZ'

type Ids = Record<string, string>
type Asked = [string, Message | undefined]

const FRONT = '---\ntype: note\n---\n'

/** What `big` is padded to, so a replacement of a few hundred characters passes the limit. */
const BIG_FILL = MARKDOWN_MAX_CHARS - FRONT.length - 'the tails end\n'.length - 64

/** The body each seeded note starts with, by the path it is created at. */
const NOTES: Record<string, string> = {
  essay: 'The cat sat on the mat. The dog sat on the log. The cat sat again.\n',
  echo: 'echo one echo two echo three\n',
  list: 'alpha beta gamma delta\n',
  touch: 'abcdef\n',
  emoji: '\u{1F600} smile \u{1F600} grin\n',
  draft: 'Intro line. The plan is simple. Outro line.\n',
  gap: 'one two three four\n',
  decided: 'alpha beta gamma\n',
  moved: 'foo and baz\n',
  big: `${'word '.repeat(Math.floor(BIG_FILL / 5))}the tails end\n`,
}

/** The documents the record is built with: each note, and a board for the refusal of a kind. */
export const seedOps = (): Message[] => [
  ...Object.entries(NOTES).map(([path, body]) => ({
    op: 'document.create',
    path,
    kind: 'markdown',
    markdown: `${FRONT}${body}`,
  })),
  { op: 'document.create', path: 'plan', kind: 'spatial' },
]

/** The passages of `decided` a person has a verdict on, as one proposal's changes. */
export const heldChanges = (): Message[] =>
  ['alpha', 'beta', 'gamma'].map((exact, at) => ({
    ...passage('decided', `old${at + 1}`, exact, { text: `${at}` }),
  }))

const quote = (body: string, exact: string, nth = 0): { start: number; end: number } => {
  let start = -1
  for (let seen = 0; seen <= nth; seen += 1) start = body.indexOf(exact, start + 1)
  return { start, end: start + exact.length }
}

/** `[start, end)` in UTF-16 units, which is what `String#indexOf` answers. */
interface Shape {
  nth?: number
  prefix?: string
  suffix?: string
  start?: number
  end?: number
  nodeId?: string
  text?: string
  assumed?: string
}

function passage(path: string, id: string, exact: string, shape: Shape = {}): Message {
  const body = NOTES[path] ?? ''
  const at = quote(body, exact, shape.nth ?? 0)
  // A passage the body does not hold still carries offsets, as a stale caller's would.
  const found = at.start < 0 ? { start: 0, end: exact.length } : at
  const context = {
    ...(shape.prefix === undefined ? {} : { prefix: shape.prefix }),
    exact,
    ...(shape.suffix === undefined ? {} : { suffix: shape.suffix }),
  }
  return {
    id,
    op: 'body.replace',
    anchor: {
      kind: 'text',
      ...(shape.nodeId === undefined ? {} : { nodeId: shape.nodeId }),
      quote: context,
      start: shape.start ?? found.start,
      end: shape.end ?? found.end,
    },
    text: shape.text ?? 'REPLACED',
    assumed: shape.assumed ?? exact,
  }
}

const aimed = (ids: Ids, path: string, ops: Message[], more: Message = {}): Message => ({
  workspaceId: W,
  documentId: ids[path],
  ops,
  ...more,
})

/** Calls the tool refuses by name, over notes and boards as seeded. */
function refusedCalls(ids: Ids): Asked[] {
  const essay = (ops: Message[], more: Message = {}) => aimed(ids, 'essay', ops, more)
  const apply = { mode: 'apply' }
  const sat = 'The dog sat on the log.'
  return [
    [
      'an assumption that no longer holds',
      essay([passage('essay', 'c1', sat, { assumed: 'The dog sat on the rug.' })], apply),
    ],
    ['a passage no longer in the body', essay([passage('essay', 'c1', 'The fish swam.')], apply)],
    [
      'one passage of several gone',
      essay(
        [
          passage('essay', 'c1', sat),
          passage('essay', 'c2', 'The fish swam.'),
          passage('essay', 'c3', 'again.'),
        ],
        apply,
      ),
    ],
    [
      'two passages that overlap',
      essay(
        [
          passage('essay', 'c1', 'The cat sat on the mat.'),
          passage('essay', 'c2', 'on the mat. The dog'),
        ],
        apply,
      ),
    ],
    [
      'two ops sharing one change id',
      essay([passage('essay', 'same', sat), passage('essay', 'same', 'again.')], apply),
    ],
    [
      'an anchor naming a node of a note',
      essay([passage('essay', 'c1', sat, { nodeId: 'n1' })], apply),
    ],
    ['a spatial document', aimed(ids, 'plan', [passage('essay', 'c1', sat)], apply)],
  ]
}

function proposalRefusedCalls(ids: Ids): Asked[] {
  const essay = (ops: Message[], more: Message = {}) => aimed(ids, 'essay', ops, more)
  const sat = 'The dog sat on the log.'
  return [
    [
      'a document the workspace does not hold',
      { workspaceId: W, documentId: NOTHING, ops: [passage('essay', 'c1', sat)] },
    ],
    [
      'a workspace nobody holds',
      { workspaceId: 'ghost', documentId: ids.essay, ops: [passage('essay', 'c1', sat)] },
    ],
    [
      'a proposal of a passage nowhere in the body',
      essay([passage('essay', 'c1', 'The fish swam.')]),
    ],
    [
      'a proposal of two passages that overlap',
      essay([
        passage('essay', 'c1', 'The cat sat on the mat.'),
        passage('essay', 'c2', 'on the mat. The dog'),
      ]),
    ],
    [
      'a proposal of two ops sharing one change id',
      essay([passage('essay', 'same', sat), passage('essay', 'same', 'again.')]),
    ],
    ['a proposal naming a node of a note', essay([passage('essay', 'c1', sat, { nodeId: 'n1' })])],
  ]
}

/** The body limit: a body the notes cannot be written past by editing. */
function limitCalls(ids: Ids): Asked[] {
  const small = passage('big', 'small', 'word', { text: 'wordier' })
  const large = (id: string, more: number) =>
    passage('big', id, 'tails end', { text: 'g'.repeat(more) })
  return [
    [
      'an edit that grows the body past the limit',
      aimed(ids, 'big', [large('g1', 400)], { mode: 'apply' }),
    ],
    [
      'a proposal whose adoption would grow the body past the limit',
      aimed(ids, 'big', [large('g1', 400)]),
    ],
    [
      'the change that grows the body most is named',
      aimed(ids, 'big', [small, large('more-growth', 500)], { mode: 'apply' }),
    ],
  ]
}

/** Writes to the note's own body. */
function applyCalls(ids: Ids): Asked[] {
  const apply = { mode: 'apply' }
  const sat = 'The dog sat on the log.'
  return [
    [
      'one passage replaced',
      aimed(ids, 'essay', [passage('essay', 'c1', sat, { text: 'The dog slept.' })], apply),
    ],
    [
      'a passage found by its quote after offsets that miss',
      aimed(
        ids,
        'essay',
        [passage('essay', 'c2', 'The cat sat again.', { start: 0, end: 3, text: 'The cat left.' })],
        apply,
      ),
    ],
    [
      'offsets that select the quote are kept among repeats',
      aimed(ids, 'echo', [passage('echo', 'c1', 'echo', { nth: 1, text: 'ECHO' })], apply),
    ],
    [
      'the nearest repeat when offsets miss and no context says',
      aimed(
        ids,
        'echo',
        [passage('echo', 'c1', 'echo', { start: 20, end: 24, assumed: 'echo', text: 'ONE' })],
        apply,
      ),
    ],
  ]
}

function applyRepeatCalls(ids: Ids): Asked[] {
  const apply = { mode: 'apply' }
  return [
    [
      'context that picks one repeat over the nearer',
      aimed(
        ids,
        'echo',
        [
          passage('echo', 'c1', 'echo', {
            start: 0,
            end: 4,
            prefix: 'two ',
            suffix: ' three',
            text: 'LAST',
          }),
        ],
        apply,
      ),
    ],
    [
      'several passages in one call, none shifted by another',
      aimed(
        ids,
        'list',
        [
          passage('list', 'c1', 'alpha', { text: 'ALPHA ALPHA' }),
          passage('list', 'c2', 'gamma', { text: 'G' }),
          passage('list', 'c3', 'delta', { text: '' }),
        ],
        apply,
      ),
    ],
    [
      'passages that merely touch',
      aimed(
        ids,
        'touch',
        [
          passage('touch', 'c1', 'abc', { text: 'X' }),
          passage('touch', 'c2', 'def', { text: 'Y' }),
        ],
        apply,
      ),
    ],
    [
      'offsets counted in UTF-16 units',
      aimed(ids, 'emoji', [passage('emoji', 'c1', 'grin', { text: 'smirk' })], apply),
    ],
  ]
}

function applyBatchCalls(ids: Ids): Asked[] {
  const apply = { mode: 'apply' }
  return [
    [
      'a passage replaced by itself writes nothing',
      aimed(ids, 'touch', [passage('touch', 'c3', 'XY', { text: 'XY' })], apply),
    ],
    [
      'offsets counted in characters resolve by quote',
      aimed(
        ids,
        'emoji',
        [passage('emoji', 'c1', 'smile', { start: 4, end: 9, text: 'beam' })],
        apply,
      ),
    ],
    [
      'a proposal id and an author with apply',
      aimed(ids, 'list', [passage('list', 'c4', 'beta', { text: 'B' })], {
        mode: 'apply',
        proposalId: 'p9',
        author: 'claude-code/1.0',
      }),
    ],
  ]
}

/** Proposals, and what a continuation keeps and refuses. */
function proposeCalls(ids: Ids): Asked[] {
  const draft = (ops: Message[], more: Message = {}) => aimed(ids, 'draft', ops, more)
  return [
    [
      'a proposal by default',
      draft([passage('draft', 'c1', 'The plan is simple.', { text: 'The plan is clear.' })]),
    ],
    [
      'a proposal opened by a named author',
      draft([passage('draft', 'a1', 'Intro line.', { text: 'Opening.' })], {
        mode: 'propose',
        author: 'claude-code/1.0',
      }),
    ],
    [
      'a call continuing a proposal adds to it and keeps its author',
      draft([passage('draft', 'a2', 'Outro line.', { text: 'Closing.' })], {
        proposalId: 'p2',
        author: 'someone-else/9',
      }),
    ],
    [
      'a change id the proposal already holds',
      draft([passage('draft', 'a2', 'is simple', { text: 'is easy' })], { proposalId: 'p2' }),
    ],
    [
      'a passage overlapping one the proposal holds',
      draft([passage('draft', 'a3', 'Intro line. The', { text: 'X' })], { proposalId: 'p2' }),
    ],
    [
      'a stale assumption is kept in a proposal',
      draft([passage('draft', 's1', 'The plan', { assumed: 'The scheme', text: 'The idea' })], {
        proposalId: 'stale',
      }),
    ],
    [
      'an offset miscount is stored at the quote',
      draft([passage('draft', 'm1', 'Outro', { start: 1, end: 3, text: 'End' })], {
        proposalId: 'p3x',
      }),
    ],
    [
      'the first free id when proposals hold others',
      draft([passage('draft', 'f1', 'Intro', { text: 'Start' })]),
    ],
  ]
}

function mintCalls(ids: Ids): Asked[] {
  const gap = (id: string, exact: string, more: Message = {}) =>
    aimed(ids, 'gap', [passage('gap', id, exact)], more)
  return [
    ['a proposal named p1', gap('c1', 'one', { proposalId: 'p1' })],
    ['a proposal named p3', gap('c2', 'three', { proposalId: 'p3' })],
    ['an id minted into a gap', gap('c3', 'two')],
    ['an id minted past the last', gap('c4', 'four')],
  ]
}

/** What a decided or a vanished change reserves. */
function reserveCalls(ids: Ids): Asked[] {
  const named = (path: string, op: Message, more: Message = {}) => aimed(ids, path, [op], more)
  return [
    [
      'a decided change no longer reserves its passage',
      named('decided', passage('decided', 'n1', 'alpha beta', { text: 'X' }), { proposalId: 'p1' }),
    ],
    [
      'an open change still reserves its passage',
      named('decided', passage('decided', 'n2', 'gamma', { text: 'Y' }), { proposalId: 'p1' }),
    ],
    [
      'a held passage that left the body',
      named('moved', passage('moved', 'a1', 'foo', { text: 'bar' }), { proposalId: 'v1' }),
    ],
    [
      'the held passage replaced by an apply',
      named('moved', passage('moved', 'a2', 'foo', { text: 'bar' }), { mode: 'apply' }),
    ],
    [
      'a gone passage reserves nothing',
      named('moved', passage('moved', 'a3', 'bar and', { start: 0, end: 7, text: 'baz' }), {
        proposalId: 'v1',
      }),
    ],
  ]
}

/** What the SDK refuses before the tool runs. */
function fieldCalls(ids: Ids): Asked[] {
  const base = (more: Message = {}): Message => ({
    workspaceId: W,
    documentId: ids.essay,
    ops: [passage('essay', 'c1', 'again.')],
    ...more,
  })
  const withOp = (op: Message): Message => base({ ops: [op] })
  const anchorOf = (more: Message): Message => {
    const given = passage('essay', 'c1', 'again.')
    return { ...given, anchor: { ...(given.anchor as Message), ...more } }
  }
  return [
    ['an unknown mode', base({ mode: 'later' })],
    ['a status on an op', withOp({ ...passage('essay', 'c1', 'again.'), status: 'open' })],
    ['no ops', base({ ops: [] })],
    [
      'too many ops',
      base({ ops: Array.from({ length: 201 }, (_, at) => passage('essay', `c${at}`, 'again.')) }),
    ],
    ['no document', { workspaceId: W, ops: [passage('essay', 'c1', 'again.')] }],
    ['no ops given', { workspaceId: W, documentId: ids.essay }],
    ['a stray key', base({ extra: true })],
    ['a document id that is no ULID', base({ documentId: 'nope' })],
    ['an empty proposal id', base({ proposalId: '' })],
    ['a proposal id past its limit', base({ proposalId: 'p'.repeat(257) })],
    ['a blank author', base({ author: ' ' })],
    ['a two-line author', base({ author: 'two\nlines' })],
    ['an author past its limit', base({ author: 'a'.repeat(257) })],
    ['an op with an empty id', withOp({ ...passage('essay', '', 'again.') })],
    ['an op of another kind', withOp({ ...passage('essay', 'c1', 'again.'), op: 'body.add' })],
    [
      'an op without an anchor',
      withOp({ id: 'c1', op: 'body.replace', text: 'x', assumed: 'again.' }),
    ],
    ['an anchor of another kind', withOp(anchorOf({ kind: 'spatial' }))],
    ['a quote of nothing', withOp(anchorOf({ quote: { exact: '' } }))],
    ['a quote past its limit', withOp(anchorOf({ quote: { exact: 'q'.repeat(1025) } }))],
  ]
}

function anchorFieldCalls(ids: Ids): Asked[] {
  const base = (more: Message = {}): Message => ({
    workspaceId: W,
    documentId: ids.essay,
    ops: [passage('essay', 'c1', 'again.')],
    ...more,
  })
  const withOp = (op: Message): Message => base({ ops: [op] })
  const anchorOf = (more: Message): Message => {
    const given = passage('essay', 'c1', 'again.')
    return { ...given, anchor: { ...(given.anchor as Message), ...more } }
  }
  return [
    [
      'a context past its limit',
      withOp(anchorOf({ quote: { exact: 'again.', prefix: 'p'.repeat(33) } })),
    ],
    ['a stray key in a quote', withOp(anchorOf({ quote: { exact: 'again.', extra: 1 } }))],
    ['a negative start', withOp(anchorOf({ start: -1 }))],
    ['a fractional end', withOp(anchorOf({ end: 1.5 }))],
    ['a passage ending before it starts', withOp(anchorOf({ start: 9, end: 3 }))],
    ['an empty node id', withOp(anchorOf({ nodeId: '' }))],
    ['a replacement that is no string', withOp({ ...passage('essay', 'c1', 'again.'), text: 4 })],
    [
      'a missing prior text',
      withOp({
        id: 'c1',
        op: 'body.replace',
        anchor: passage('essay', 'c1', 'again.').anchor,
        text: 'x',
      }),
    ],
    [
      'a prior text past its limit',
      withOp({ ...passage('essay', 'c1', 'again.'), assumed: 'a'.repeat(MARKDOWN_MAX_CHARS + 1) }),
    ],
    ['a negative end before a negative start', withOp(anchorOf({ start: -1, end: -5 }))],
    ['a fractional start after its end', withOp(anchorOf({ start: 1.5, end: 1 }))],
    [
      'a quote of nothing and a passage ending early',
      withOp(anchorOf({ quote: { exact: '' }, start: 9, end: 3 })),
    ],
    [
      'an empty node id and a passage ending early',
      withOp(anchorOf({ nodeId: '', start: 9, end: 3 })),
    ],
    [
      'a kind that is wrong and a passage ending early',
      withOp(anchorOf({ kind: 'x', start: 9, end: 3 })),
    ],
    ['a missing start beside an end', withOp(anchorOf({ start: undefined }))],
    ['an empty author', base({ author: '' })],
    ['an author past its limit with trailing space', base({ author: `${'a'.repeat(256)} ` })],
    ['a proposal id that is no string', base({ proposalId: 4 })],
    ['an author that is no string', base({ author: 4 })],
  ]
}

function textFieldCalls(ids: Ids): Asked[] {
  const base = (more: Message = {}): Message => ({
    workspaceId: W,
    documentId: ids.essay,
    ops: [passage('essay', 'c1', 'again.')],
    ...more,
  })
  const withOp = (op: Message): Message => base({ ops: [op] })
  const anchorOf = (more: Message): Message => {
    const given = passage('essay', 'c1', 'again.')
    return { ...given, anchor: { ...(given.anchor as Message), ...more } }
  }
  return [
    ['a start that is a string', withOp(anchorOf({ start: '1' }))],
    ['a start past the safe range', withOp(anchorOf({ start: 1e20, end: 1e21 }))],
    ['a change id past its limit', withOp(passage('essay', 'c'.repeat(257), 'again.'))],
    ['an op id that is no string', withOp({ ...passage('essay', 'c1', 'again.'), id: 4 })],
    ['no mode value null', base({ mode: null })],
    ['ops that are null', base({ ops: null })],
    ['an op of null', base({ ops: [null] })],
    ['two faults in two fields of one op', withOp({ ...passage('essay', '', 'again.'), text: 4 })],
    [
      'a stray key in an op and another in the call',
      { ...base({ extra: 1 }), ops: [{ ...passage('essay', 'c1', 'again.'), more: 2 }] },
    ],
    ['an op naming nothing', withOp({})],
    ['an anchor that is no object', withOp({ ...passage('essay', 'c1', 'again.'), anchor: 'x' })],
    ['a quote that is no object', withOp(anchorOf({ quote: 'x' }))],
    ['a context that is no string', withOp(anchorOf({ quote: { exact: 'again.', suffix: 3 } }))],
    ['an exact that is no string', withOp(anchorOf({ quote: { exact: 3 } }))],
    ['a missing exact', withOp(anchorOf({ quote: {} }))],
    ['a node id that is no string', withOp(anchorOf({ nodeId: 3 }))],
    ['an op that is no object', base({ ops: ['x'] })],
    ['ops that are no array', base({ ops: 'x' })],
  ]
}

/** What the SDK words for a value no schema of this tool names a type for: a list or an object that carries a length. */
function lengthCalls(ids: Ids): Asked[] {
  const base = (more: Message = {}): Message => ({
    workspaceId: W,
    documentId: ids.essay,
    ops: [passage('essay', 'c1', 'again.')],
    ...more,
  })
  const withOp = (op: Message): Message => base({ ops: [op] })
  const anchorOf = (more: Message): Message => {
    const given = passage('essay', 'c1', 'again.')
    return { ...given, anchor: { ...(given.anchor as Message), ...more } }
  }
  return [
    ['ops that are an empty string', base({ ops: '' })],
    ['ops that are a string of astral characters', base({ ops: '\u{1F600}'.repeat(150) })],
    ['ops that are a string of the most ops', base({ ops: 'o'.repeat(200) })],
    [
      'ops that are the most ops, none an object',
      base({ ops: Array.from({ length: 200 }, () => 'x') }),
    ],
    [
      'a proposal id that is an object of the longest length',
      base({ proposalId: { length: 256 } }),
    ],
    ['a proposal id of the most characters', base({ proposalId: 'q'.repeat(256) })],
    [
      'a proposal id of too many units and few characters',
      base({ proposalId: '\u{1F600}'.repeat(200) }),
    ],
    ['ops that are a long string', base({ ops: 'o'.repeat(201) })],
    ['ops that are an object with a length', base({ ops: { length: 5 } })],
    ['ops that are an object with no length', base({ ops: {} })],
    ['a proposal id that is an empty array', base({ proposalId: [] })],
    ['a proposal id that is an array', base({ proposalId: ['a'] })],
    ['a proposal id that is an object with a length', base({ proposalId: { length: 0 } })],
    ['an author that is an array', base({ author: ['a'] })],
    ['an author that is an object with a length', base({ author: { length: 300 } })],
    ['an op id that is an array', withOp({ ...passage('essay', 'c1', 'again.'), id: [] })],
    ['a node id that is an array', withOp(anchorOf({ nodeId: [] }))],
    ['a context that is an array', withOp(anchorOf({ quote: { exact: 'again.', prefix: ['a'] } }))],
    [
      'a proposal id that is a long array',
      base({ proposalId: Array.from({ length: 300 }, () => 'a') }),
    ],
    ['a proposal id that is an object with a long length', base({ proposalId: { length: 300 } })],
    [
      'a context that is a long array',
      withOp(
        anchorOf({ quote: { exact: 'again.', prefix: Array.from({ length: 40 }, () => 'a') } }),
      ),
    ],
    [
      'an exact that is an object with a long length',
      withOp(anchorOf({ quote: { exact: { length: 2000 } } })),
    ],
    ['a node id that is an object with no length', withOp(anchorOf({ nodeId: { length: 0 } }))],
    [
      'a prior text that is an empty array',
      withOp({ ...passage('essay', 'c1', 'again.'), assumed: [] }),
    ],
    ['an author that is an empty array', base({ author: [] })],
    ['an exact that is an array', withOp(anchorOf({ quote: { exact: [] } }))],
    [
      'a prior text that is an array',
      withOp({ ...passage('essay', 'c1', 'again.'), assumed: ['a'] }),
    ],
    [
      'a prior text that is an object with a length',
      withOp({ ...passage('essay', 'c1', 'again.'), assumed: { length: 300000 } }),
    ],
  ]
}

/** Numbers and refinements the SDK words in ways beside one another. */
function numberCalls(ids: Ids): Asked[] {
  const withOp = (op: Message): Message => ({
    workspaceId: W,
    documentId: ids.essay,
    ops: [op],
  })
  const anchorOf = (more: Message): Message => {
    const given = passage('essay', 'c1', 'again.')
    return { ...given, anchor: { ...(given.anchor as Message), ...more } }
  }
  return [
    ['a negative fractional start', withOp(anchorOf({ start: -1.5, end: 3 }))],
    ['a start below the safe range', withOp(anchorOf({ start: -1e20, end: 3 }))],
    ['an end below the safe range', withOp(anchorOf({ start: 0, end: -1e20 }))],
    ['a start past the safe range and an end before it', withOp(anchorOf({ start: 1e20, end: 5 }))],
    ['a stray key in an anchor that ends early', withOp(anchorOf({ extra: 1, start: 9, end: 3 }))],
    [
      'a stray key in a quote of an anchor that ends early',
      withOp(anchorOf({ quote: { exact: 'again.', extra: 1 }, start: 9, end: 3 })),
    ],
    ['an end that is a string', withOp(anchorOf({ end: '9' }))],
  ]
}

export function calls(ids: Ids): Asked[] {
  return [
    ...refusedCalls(ids),
    ...proposalRefusedCalls(ids),
    ...limitCalls(ids),
    ...fieldCalls(ids),
    ...anchorFieldCalls(ids),
    ...textFieldCalls(ids),
    ...lengthCalls(ids),
    ...numberCalls(ids),
    ...applyCalls(ids),
    ...applyRepeatCalls(ids),
    ...applyBatchCalls(ids),
    ...proposeCalls(ids),
    ...mintCalls(ids),
    ...reserveCalls(ids),
  ]
}
