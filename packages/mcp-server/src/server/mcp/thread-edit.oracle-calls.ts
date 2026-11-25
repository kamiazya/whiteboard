/**
 * The calls `thread-edit.oracle.test.ts` records, in order, by what each one
 * is about. Held apart from the recorder so neither outgrows the file budget.
 */

const NOTHING = '01BX5ZZKBKACTAV9WEVGEMMVRZ'

type Message = Record<string, unknown>

type Ids = Record<string, string>

type Asked = [string, Message | undefined]

/**
 * The workspaces the recording holds, by the id each is addressed with and the
 * segment each is known by; set once from the record the calls are drawn for.
 */
const held = { main: '', crowd: '', segment: '', crowdSegment: '' }

const thread = (
  documentId: string | undefined,
  ops: Message[],
  workspaceId = held.main,
): Message => ({
  workspaceId,
  documentId,
  ops,
})

const doc = { kind: 'document' }
const quote = (exact: string, start: number, end: number, more: Message = {}): Message => ({
  kind: 'text',
  quote: { exact, ...more },
  start,
  end,
})
const add = (anchor: Message, body: string, more: Message = {}): Message => ({
  op: 'thread.add',
  anchor,
  body,
  ...more,
})
const reply = (threadId: string, body: string, more: Message = {}): Message => ({
  op: 'message.add',
  threadId,
  body,
  ...more,
})
const resolve = (threadId: string, resolved?: boolean): Message => ({
  op: 'thread.resolve',
  threadId,
  ...(resolved === undefined ? {} : { resolved }),
})

/** Threads on a note and the conversations around them. */
function noteCalls(ids: Ids): Asked[] {
  const on = (ops: Message[]) => thread(ids.note, ops)
  return [
    [
      'a passage on a note',
      on([
        add(quote('migration', 5, 14), 'this paragraph contradicts the one above', {
          author: 'agent:reviewer',
        }),
      ]),
    ],
    [
      'a reply with an author',
      on([reply('t1', 'because of the migration', { author: 'agent:me' })]),
    ],
    ['a resolve', on([resolve('t1')])],
    ['a reopen', on([resolve('t1', false)])],
    ['a resolve naming true', on([resolve('t1', true)])],
    ['a resolve of a resolved thread', on([resolve('t1', true)])],
    [
      'a thread opened and replied to in one batch',
      on([
        { ...add(doc, 'opened in this batch'), threadId: 'th-batch' },
        reply('th-batch', 'replied in the same batch'),
      ]),
    ],
    [
      'two replies in one batch',
      on([
        { ...add(doc, 'first'), threadId: 'th-2' },
        reply('th-2', 'second'),
        reply('th-2', 'third'),
      ]),
    ],
    ['offsets past the end of the body', on([add(quote('migration', 100, 109), 'a')])],
    ['offsets that select other text', on([add(quote('migration', 0, 9), 'b')])],
    ['offsets of the wrong width', on([add(quote('migration', 4, 6), 'c')])],
    [
      'a quote with context, offsets right',
      on([add(quote('why', 1, 4, { prefix: '', suffix: ' migr' }), 'd')]),
    ],
    [
      'every op kind and a reopen in one batch',
      on([resolve('th-batch'), reply('t1', 'again'), resolve('th-batch', false), add(doc, 'e')]),
    ],
  ]
}

/** Bodies at the edge of what a message may say, and what blank means. */
function bodyCalls(ids: Ids): Asked[] {
  const on = (ops: Message[]) => thread(ids.note, ops)
  return [
    [
      'a body of quotes, newlines and escapes',
      on([add(doc, 'say "hi"\\n\n\tand \u0007 \u2028 \u{1F600} \u65e5\u672c')]),
    ],
    ['a body a thousand characters long', on([add(doc, 'y'.repeat(1000))])],
    ['a body of the longest length', on([add(doc, 'z'.repeat(4096))])],
    ['an author as long as it may be', on([add(doc, 'f', { author: 'a'.repeat(256) })])],
    ['a body trimmed to nothing, a byte order mark', on([add(doc, '\ufeffx')])],
    ['a body of a next-line character', on([add(doc, '\u0085')])],
    ['a body of a mongolian vowel separator', on([add(doc, '\u180e')])],
    ['a body of a line separator', on([add(doc, '\u2028')])],
    ['a body of the ideographic space', on([add(doc, '\u3000')])],
    ['a body of a byte order mark alone', on([add(doc, '\ufeff')])],
  ]
}

/** Quotes found among several occurrences, and by UTF-16 offsets. */
function passageCalls(ids: Ids): Asked[] {
  const echo = (anchor: Message) => thread(ids.echo, [add(anchor, 'about this')])
  const wide = (anchor: Message) => thread(ids.wide, [add(anchor, 'about this')])
  return [
    ['offsets that select the second of two', echo(quote('echo', 11, 15))],
    ['offsets that select the first of two', echo(quote('echo', 1, 5))],
    [
      'a context that picks the second',
      echo(quote('echo', 0, 4, { prefix: ', ', suffix: ' two' })),
    ],
    ['a context that picks the first', echo(quote('echo', 12, 16, { prefix: '', suffix: ' one' }))],
    ['a tie going to the nearest', echo(quote('echo', 9, 13))],
    ['a tie going to the lower of two equally near', echo(quote('echo', 6, 10))],
    ['a quote after an emoji', wide(quote('end', 0, 3))],
    ['a quote of an emoji', wide(quote('\u{1F600}', 5, 7))],
    ['offsets counted in units after an emoji', wide(quote('start', 3, 8))],
  ]
}

/** Threads on a canvas, announced to the pages that watch it. */
function boardCalls(ids: Ids): Asked[] {
  const on = (ops: Message[]) => thread(ids.board, ops)
  const spatial = (more: Message): Message => ({ kind: 'spatial', x: 5000, y: 5000, ...more })
  return [
    [
      'every anchor that names something on a board',
      on([
        add(spatial({}), 'a spot'),
        add(spatial({ nodeId: 'a', x: 0, y: 0 }), 'a node'),
        add(spatial({ edgeId: 'e1', x: 0, y: 0 }), 'an edge'),
        add(spatial({ nodeIds: ['a', 'b'], x: 0, y: 0, width: 500, height: 60 }), 'a set'),
        add(
          { kind: 'text', nodeId: 'a', quote: { exact: 'beta' }, start: 6, end: 10 },
          'a passage',
        ),
        add(doc, 'the board'),
      ]),
    ],
    ['a region of the board', on([add(spatial({ width: 40, height: 30 }), 'a region')])],
    ['the second edge', on([add(spatial({ edgeId: 'e2', x: 0, y: 0 }), 'e2')])],
    [
      'offsets that select other text in a node',
      on([add({ kind: 'text', nodeId: 'a', quote: { exact: 'beta' }, start: 0, end: 4 }, 'x')]),
    ],
    [
      'a quote in a node holding an emoji',
      on([add({ kind: 'text', nodeId: 'c', quote: { exact: 'Delta' }, start: 0, end: 5 }, 'x')]),
    ],
    ['a reply on a board', on([reply('t1', 'a reply'), reply('t2', 'another')])],
    ['a resolve and a reopen on a board', on([resolve('t1'), resolve('t2'), resolve('t2', false)])],
    [
      'six more threads, minted past nine',
      on(Array.from({ length: 6 }, (_, at) => add(doc, `more ${at}`))),
    ],
    [
      'ids that sort differently in UTF-16 and UTF-8',
      on([
        { ...add(doc, 'astral'), threadId: '\u{1F600}' },
        { ...add(doc, 'fullwidth'), threadId: '\uff5a' },
      ]),
    ],
    ['a thread id that is taken', on([{ ...add(doc, 'again'), threadId: 't1' }])],
    [
      'a minted id that is the first free, then the next',
      on([{ ...add(doc, 'taking t40'), threadId: 't40' }, add(doc, 'minting'), add(doc, 'again')]),
    ],
  ]
}

/** What a gap in the messages a peer merged in, and what a bare document leaves. */
function idCalls(ids: Ids): Asked[] {
  return [
    ['a reply minted above a gap', thread(ids.gap, [reply('th-1', 'ours')])],
    ['a second reply above the gap', thread(ids.gap, [reply('th-1', 'ours again')])],
    [
      'a custom id then a minted one',
      thread(ids.bare, [{ ...add(doc, 'a'), threadId: 't1' }, add(doc, 'b')]),
    ],
    ['a custom id held by the document', thread(ids.bare, [{ ...add(doc, 'a'), threadId: 't1' }])],
    [
      'the id of a thread opened earlier in the batch',
      thread(ids.quiet, [
        { ...add(doc, 'a'), threadId: 'x' },
        { ...add(doc, 'b'), threadId: 'x' },
      ]),
    ],
    ['threads on a canvas nobody watches', thread(ids.quiet, [add(doc, 'a'), resolve('t1')])],
  ]
}

/** Ops the operation refuses, by what each names that is not there. */
function refusedCalls(ids: Ids): Asked[] {
  const board = (ops: Message[]) => thread(ids.board, ops)
  const note = (ops: Message[]) => thread(ids.note, ops)
  const spatial = (more: Message): Message => ({ kind: 'spatial', x: 0, y: 0, ...more })
  return [
    ['a reply to a thread nothing holds', note([reply('nope', 'into the void')])],
    ['a resolve of a thread nothing holds', note([resolve('nope')])],
    ['a reply to a thread of the id of an object', note([reply('constructor', 'x')])],
    ['a blank body, spaces', board([add(doc, '   ')])],
    ['a blank body, a newline and a tab', board([add(doc, '\n\t')])],
    ['a blank body, a no-break space', board([add(doc, '\u00a0')])],
    ['a blank reply after a good op', board([resolve('t1'), reply('t1', '  ')])],
    ['a node the board lacks', board([add(spatial({ nodeId: 'nope' }), 'x')])],
    ['an edge the board lacks', board([add(spatial({ edgeId: 'nope' }), 'x')])],
    [
      'one of a set the board lacks',
      board([add(spatial({ nodeIds: ['a', 'nope'], width: 10, height: 10 }), 'x')]),
    ],
    [
      'a text node the board lacks',
      board([
        add({ kind: 'text', nodeId: 'nope', quote: { exact: 'Alpha' }, start: 0, end: 5 }, 'x'),
      ]),
    ],
    [
      'a passage in a node with no text',
      board([add({ kind: 'text', nodeId: 'f', quote: { exact: 'some' }, start: 0, end: 4 }, 'x')]),
    ],
    [
      'a passage absent from its node',
      board([add({ kind: 'text', nodeId: 'a', quote: { exact: 'zzz' }, start: 0, end: 3 }, 'x')]),
    ],
    ['a passage with no node on a canvas', board([add(quote('Alpha', 0, 5), 'x')])],
    [
      'a quote with a quotation mark absent',
      board([
        add({ kind: 'text', nodeId: 'a', quote: { exact: 'say "hi"\n' }, start: 0, end: 5 }, 'x'),
      ]),
    ],
    ['a spatial anchor on a note', note([add(spatial({ x: 1, y: 2 }), 'x')])],
    ['a passage absent from the note', note([add(quote('zzz', 0, 3), 'x')])],
    [
      'a passage naming a node of a note',
      note([add({ kind: 'text', nodeId: 'a', quote: { exact: 'why' }, start: 0, end: 3 }, 'x')]),
    ],
    ['an empty quote', note([add(quote('', 0, 0), 'x')])],
    ['a good op then a bad one', board([add(doc, 'kept?'), resolve('nope')])],
  ]
}

/** Documents and workspaces the operation cannot reach, or reads in a retired shape. */
function missingCalls(ids: Ids): Asked[] {
  return [
    ['a canvas in the retired elements list', thread(ids.elderly, [add(doc, 'x')])],
    ['comments in the retired plane', thread(ids.archive, [add(doc, 'x')])],
    ['a document nothing holds', thread(NOTHING, [add(doc, 'x')])],
    ['a document nothing holds, by segment', thread(NOTHING, [add(doc, 'x')], held.segment)],
    ['a workspace nothing answers to', thread(ids.note, [add(doc, 'x')], 'nope')],
    ['another namespace', thread(ids.note, [add(doc, 'x')], `you/${held.segment}`)],
    ['a document of another workspace', thread(ids.note, [add(doc, 'x')], held.crowdSegment)],
  ]
}

/** The ceilings on open threads and on messages in one thread. */
function ceilingCalls(crowded: Ids): Asked[] {
  const at = (documentId: string | undefined, ops: Message[]) => thread(documentId, ops, held.crowd)
  return [
    ['a thread past the open ceiling', at(crowded.open500, [add(doc, 'x')])],
    [
      'a resolve and a reopen at the open ceiling',
      at(crowded.open500, [
        resolve('o1'),
        resolve('o2'),
        resolve('o1', false),
        resolve('o2', false),
      ]),
    ],
    ['a reply at the open ceiling', at(crowded.open500, [reply('o1', 'a reply')])],
    [
      'a resolve then a thread, at the ceiling',
      at(crowded.open500, [resolve('o1'), add(doc, 'x')]),
    ],
    ['a reopen past the open ceiling', at(crowded.open500, [resolve('o1', false)])],
    [
      'a reopen then a resolve, which leaves the count',
      at(crowded.open500, [resolve('o1', false), resolve('o2')]),
    ],
    ['a thread past the ceiling again', at(crowded.open500, [add(doc, 'y')])],
    [
      'two threads past the ceiling, the second named',
      at(crowded.open500, [resolve('o2'), add(doc, 'x'), add(doc, 'y')]),
    ],
    [
      'two replies from below the ceiling, the second past it',
      at(crowded.deep, [reply('d', 'one'), reply('d', 'two')]),
    ],
    ['the reply that brings a thread to the ceiling', at(crowded.deep, [reply('d', 'last')])],
    ['the reply one past it', at(crowded.deep, [reply('d', 'one more')])],
    ['a sibling thread beside a full one', at(crowded.deep, [add(doc, 'a sibling')])],
    [
      'a reply past the ceiling counting a stored message the schema refuses',
      at(crowded.junk, [reply('j', 'one more')]),
    ],
  ]
}

/**
 * The first thread a document takes: its copy registers the `comments` root
 * beside the `threads` one, so the write changes two roots. They come last,
 * since a document the daemon wrote is not one the replay left alone.
 */
function firstCalls(ids: Ids): Asked[] {
  return [
    ['the first thread of a note', thread(ids.fresh, [add(doc, 'first')])],
    ['the first thread of a board', thread(ids.freshboard, [add(doc, 'first')])],
  ]
}

/** Arguments the SDK refuses before the tool runs. */
function invalidCalls(ids: Ids): Asked[] {
  const base = { workspaceId: held.main, documentId: ids.note, ops: [add(doc, 'x')] }
  const many = (count: number, op: Message): Message[] => Array.from({ length: count }, () => op)
  return [
    ['no arguments', undefined],
    ['empty arguments', {}],
    ['no ops', { workspaceId: held.main, documentId: ids.note }],
    ['an empty list of ops', { ...base, ops: [] }],
    ['201 ops', { ...base, ops: many(201, resolve('nope')) }],
    ['201 unreadable ops', { ...base, ops: many(201, { op: 'nope' }) }],
    ['a string for the ops', { ...base, ops: 'x' }],
    ['a lowercase document id', { ...base, documentId: ids.note?.toLowerCase() }],
    ['a bad address', { ...base, workspaceId: 'a_b' }],
    ['an unknown key', { ...base, extra: 1 }],
    ['every top-level field wrong', { workspaceId: 1, documentId: null, ops: 3, extra: true }],
    ['an op of no kind', { ...base, ops: [{ body: 'x' }] }],
    ['an unknown op', { ...base, ops: [{ op: 'thread.remove', threadId: 't1' }] }],
    ['an empty body', { ...base, ops: [add(doc, '')] }],
    ['a body past the limit', { ...base, ops: [add(doc, 'z'.repeat(4097))] }],
    ['an author past the limit', { ...base, ops: [add(doc, 'x', { author: 'a'.repeat(257) })] }],
    ['a thread id of nothing', { ...base, ops: [{ ...add(doc, 'x'), threadId: '' }] }],
    ['a reply with no thread', { ...base, ops: [{ op: 'message.add', body: 'x' }] }],
    ['an unknown key on an op', { ...base, ops: [{ ...add(doc, 'x'), extra: 1 }] }],
    ['an anchor of no kind', { ...base, ops: [add({}, 'x')] }],
    [
      'a spatial anchor naming a node and an edge',
      { ...base, ops: [add({ kind: 'spatial', x: 0, y: 0, nodeId: 'a', edgeId: 'e1' }, 'x')] },
    ],
    [
      'a region with a width alone',
      { ...base, ops: [add({ kind: 'spatial', x: 0, y: 0, width: 4 }, 'x')] },
    ],
    [
      'a node set naming one node twice',
      { ...base, ops: [add({ kind: 'spatial', x: 0, y: 0, nodeIds: ['a', 'a'] }, 'x')] },
    ],
    ['a point at a fraction', { ...base, ops: [add({ kind: 'spatial', x: 0.5, y: 0 }, 'x')] }],
    [
      'a quote context past the limit',
      { ...base, ops: [add(quote('why', 0, 3, { prefix: 'p'.repeat(33) }), 'x')] },
    ],
    [
      'a resolved flag that is no boolean',
      { ...base, ops: [{ ...resolve('t1'), resolved: 'yes' }] },
    ],
    ...shapeBatches(base),
  ]
}

/** Every call that names a shape or a limit of the ops, in the order they are recorded. */
function shapeBatches(base: Message): Asked[] {
  return [
    ...shapeCalls(base),
    ...anchorShapeCalls(base),
    ...faultCalls(base),
    ...limitCalls(base),
    ...strangeCalls(base),
  ]
}

/** Ops and anchors of the wrong shape, one fault at a time and then together. */
function shapeCalls(base: Message): Asked[] {
  const one = (op: unknown): Message => ({ ...base, ops: [op] })
  return [
    ['a number for an op', one(5)],
    ['null for an op', one(null)],
    ['a string for an op', one('x')],
    ['an array for an op', one([])],
    ['a number for the op kind', one({ op: 5 })],
    ['null for the op kind', one({ op: null })],
    ['a number for the body', one({ op: 'thread.add', anchor: doc, body: 5 })],
    ['no body', one({ op: 'thread.add', anchor: doc })],
    ['a number for the author', one({ ...add(doc, 'x'), author: 5 })],
    ['a blank author', one({ ...add(doc, 'x'), author: '' })],
    ['a spaces author', one({ ...add(doc, 'x'), author: '  ' })],
    ['a newline in the author', one({ ...add(doc, 'x'), author: 'a\nb' })],
    ['a number for the thread id', one({ ...add(doc, 'x'), threadId: 5 })],
    ['a thread id past the limit', one({ ...add(doc, 'x'), threadId: 'i'.repeat(257) })],
    ['a thread id of the longest length', one({ ...add(doc, 'x'), threadId: 'i'.repeat(256) })],
    ['a number for a reply thread id', one({ op: 'message.add', threadId: 5, body: 'x' })],
    ['an empty reply thread id', one({ op: 'message.add', threadId: '', body: 'x' })],
    [
      'a very long reply thread id',
      one({ op: 'message.add', threadId: 'i'.repeat(300), body: 'x' }),
    ],
    ['a number for a resolve thread id', one({ op: 'thread.resolve', threadId: 5 })],
    ['null for resolved', one({ ...resolve('t1'), resolved: null })],
  ]
}

/** Anchors of the wrong shape. */
function anchorShapeCalls(base: Message): Asked[] {
  const one = (op: unknown): Message => ({ ...base, ops: [op] })
  const anchored = (anchor: unknown): Message => one({ op: 'thread.add', anchor, body: 'x' })
  const spatial = (more: Message): Message => ({ kind: 'spatial', x: 0, y: 0, ...more })
  return [
    ['a string for the anchor', anchored('x')],
    ['null for the anchor', anchored(null)],
    ['no anchor', one({ op: 'thread.add', body: 'x' })],
    ['a number for the anchor kind', anchored({ kind: 5 })],
    ['an unknown anchor kind', anchored({ kind: 'line' })],
    ['a document anchor with an extra key', anchored({ kind: 'document', x: 1 })],
    ['a spatial anchor with no x', anchored({ kind: 'spatial', y: 0 })],
    ['a spatial anchor with a string x', anchored(spatial({ x: '1' }))],
    ['a spatial anchor with an extra key', anchored(spatial({ z: 1 }))],
    ['an empty node id in an anchor', anchored(spatial({ nodeId: '' }))],
    ['a number for a node id in an anchor', anchored(spatial({ nodeId: 5 }))],
    ['a node set of one', anchored(spatial({ nodeIds: ['a'], width: 1, height: 1 }))],
    ['a node set that is no list', anchored(spatial({ nodeIds: 'a' }))],
    [
      'a node set of 2001',
      anchored(
        spatial({
          nodeIds: Array.from({ length: 2001 }, (_, at) => `n${at}`),
          width: 1,
          height: 1,
        }),
      ),
    ],
    ['a negative width', anchored(spatial({ width: -1, height: 1 }))],
    ['a text anchor ending before it starts', anchored(quote('why', 3, 1))],
    ['a text anchor without a quote', anchored({ kind: 'text', start: 0, end: 1 })],
    [
      'a text anchor quote that is a string',
      anchored({ kind: 'text', quote: 'why', start: 0, end: 3 }),
    ],
    ['a text anchor quote past the limit', anchored(quote('q'.repeat(1025), 0, 1025))],
    ['a text anchor quote of the longest length', anchored(quote('q'.repeat(1024), 0, 1024))],
    ['a quote with an unknown key', anchored(quote('why', 0, 3, { note: 1 }))],
    ['a negative start', anchored(quote('why', -1, 3))],
    ['a fractional end', anchored(quote('why', 0, 3.5))],
    ['a missing end', anchored({ kind: 'text', quote: { exact: 'why' }, start: 0 })],
    ['an empty node id in a text anchor', anchored({ ...quote('why', 0, 3), nodeId: '' })],
    ['a number for a quote context', anchored(quote('why', 0, 3, { suffix: 5 }))],
  ]
}

/** More than one fault in a call. */
function faultCalls(base: Message): Asked[] {
  const one = (op: unknown): Message => ({ ...base, ops: [op] })
  return [
    ['two faults in one op', one({ op: 'thread.add', anchor: 3, body: '' })],
    [
      'a fault in each of two ops',
      { ...base, ops: [{ op: 'thread.add', anchor: doc, body: '' }, { op: 'nope' }] },
    ],
    [
      'a fault beside a bad document id',
      { ...base, documentId: 'x', ops: [{ op: 'thread.add', anchor: doc, body: '' }] },
    ],
    [
      'a fault beside an unknown key',
      { ...base, extra: 1, ops: [{ op: 'thread.add', anchor: doc, body: '' }] },
    ],
    [
      'a fault in an op of the second place',
      { ...base, ops: [add(doc, 'x'), { op: 'thread.resolve' }] },
    ],
    ['an empty string for the ops', { ...base, ops: '' }],
    ['a string of 201 characters for the ops', { ...base, ops: 's'.repeat(201) }],
    ['a string of 200 characters for the ops', { ...base, ops: 's'.repeat(200) }],
    ['exactly 200 ops', { ...base, ops: Array.from({ length: 200 }, () => resolve('nope')) }],
    ['a body of 2049 emoji, which is 4098 units', one({ ...add(doc, '\u{1F600}'.repeat(2049)) })],
    ['a body of 2048 emoji, which is 4096 units', one({ ...add(doc, '\u{1F600}'.repeat(2048)) })],
    ['an author with a space before it', one({ ...add(doc, 'x'), author: ' a' })],
    ['an author with a space after it', one({ ...add(doc, 'x'), author: 'a ' })],
    ['an author with a carriage return inside', one({ ...add(doc, 'x'), author: 'a\rb' })],
    ['an author with a line feed inside', one({ ...add(doc, 'x'), author: 'a\nb' })],
    ['an author with a no-break space around it', one({ ...add(doc, 'x'), author: '\u00a0a' })],
  ]
}

/** Values on either side of what an anchor's numbers and strings may be. */
function limitCalls(base: Message): Asked[] {
  const anchored = (anchor: unknown): Message => ({
    ...base,
    ops: [{ op: 'thread.add', anchor, body: 'x' }],
  })
  const point = (more: Message): Message => anchored({ kind: 'spatial', x: 0, y: 0, ...more })
  const emoji = (count: number) => '\u{1F600}'.repeat(count)
  return [
    ['a point at the largest safe integer', point({ x: 9007199254740991 })],
    ['a point past the largest safe integer', point({ x: 9007199254740992 })],
    ['a point far past the safe range', point({ y: 1e300 })],
    ['a point at the smallest safe integer', point({ x: -9007199254740991 })],
    ['a region of nothing', point({ width: 0, height: 0 })],
    ['a region of a fraction', point({ width: 0.5, height: 1 })],
    ['a region of a negative fraction', point({ width: -0.5, height: 1 })],
    ['a node set of 2000', point({ nodeIds: Array.from({ length: 2000 }, (_, at) => `n${at}`) })],
    ['a node set of 2', point({ nodeIds: ['a', 'b'] })],
    ['a context of 32 characters', anchored(quote('why', 1, 4, { prefix: 'p'.repeat(32) }))],
    ['a context of 16 emoji, 32 units', anchored(quote('why', 1, 4, { suffix: emoji(16) }))],
    ['a context of 17 emoji, 34 units', anchored(quote('why', 1, 4, { suffix: emoji(17) }))],
    ['a context of 33 characters', anchored(quote('why', 1, 4, { prefix: 'p'.repeat(33) }))],
  ]
}

/** Values of a kind no schema member of theirs expects, which the SDK words with a length. */
function strangeCalls(base: Message): Asked[] {
  const one = (op: unknown): Message => ({ ...base, ops: [op] })
  const anchored = (anchor: unknown): Message => one({ op: 'thread.add', anchor, body: 'x' })
  const point = (more: Message): Message => anchored({ kind: 'spatial', x: 0, y: 0, ...more })
  return [
    ['an object for the ops', { ...base, ops: {} }],
    ['an object with a length for the ops', { ...base, ops: { length: 0 } }],
    ['an array for the body', one({ ...add(doc, 'x'), body: [] })],
    ['an object for the author', one({ ...add(doc, 'x'), author: {} })],
    ['an object with a length for the author', one({ ...add(doc, 'x'), author: { length: 0 } })],
    ['a point below the smallest safe integer', point({ x: -9007199254740992 })],
    ['an array for a coordinate', point({ x: [] })],
    ['a node set of one empty name', point({ nodeIds: [''] })],
    ['an array for a quote', anchored({ kind: 'text', quote: [], start: 0, end: 1 })],
    ['an array for an anchor', anchored([])],
    ['a stray key beside a broken region', point({ z: 1, width: 4 })],
  ]
}

/** The calls the recording answers, in order, by what each one is about. */
export function calls(record: Message): Asked[] {
  const [main = '', crowd = ''] = Object.keys(record.snapshots as Message)
  const [segment = '', crowdSegment = ''] = record.known as string[]
  Object.assign(held, { main, crowd, segment, crowdSegment })
  const ids = record.ids as Ids
  const crowded = record.crowded as Ids
  return [
    ...noteCalls(ids),
    ...bodyCalls(ids),
    ...passageCalls(ids),
    ...boardCalls(ids),
    ...idCalls(ids),
    ...refusedCalls(ids),
    ...missingCalls(ids),
    ...ceilingCalls(crowded),
    ...invalidCalls(ids),
    ...firstCalls(ids),
  ]
}
