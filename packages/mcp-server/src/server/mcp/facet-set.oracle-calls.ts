/**
 * The calls `facet-set.oracle.test.ts` records, by what each one is about:
 * the writes the tool answers, the refusals it owns, the arguments the SDK
 * refuses, and the calls the Rust core leaves pending, which come last
 * because the daemon writes for them and nothing after them may read it.
 */

type Message = Record<string, unknown>

const W = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const SEGMENT = 'notes'
const NOTHING = '01BX5ZZKBKACTAV9WEVGEMMVRZ'

type Ids = Record<string, string>
type Asked = [string, Message | undefined]

const manyTags = (count: number, prefix = 't') =>
  Array.from({ length: count }, (_, at) => `${prefix}${at}`)

/** Writes the tool answers, one document and site at a time. */
function noteCalls1(ids: Ids): Asked[] {
  const note = (more: Message): Message => ({ workspaceId: W, documentIds: [ids.note], ...more })
  return [
    ['a tag added to a note', note({ tags: { add: ['reviewed'] } })],
    ['a tag added twice is kept once', note({ tags: { add: ['reviewed', 'reviewed'] } })],
    ['a tag already present', note({ tags: { add: ['draft'] } })],
    ['a tag removed by name', note({ tags: { remove: ['draft'] } })],
    ['a tag removed that is not there', note({ tags: { remove: ['nothing'] } })],
    ['a scoped tag added', note({ tags: { add: ['health:ok'] } })],
    ['a tag renamed', note({ tags: { rename: [{ from: 'env:dev', to: 'env:prod' }] } })],
    [
      'a rename onto a present tag merges',
      note({ tags: { rename: [{ from: 'reviewed', to: 'health:ok' }] } }),
    ],
    [
      'the first of two renames of one tag',
      note({
        tags: {
          rename: [
            { from: 'health:ok', to: 'a' },
            { from: 'health:ok', to: 'b' },
          ],
        },
      }),
    ],
    [
      'a rename and a removal of the new spelling',
      note({ tags: { rename: [{ from: 'a', to: 'z' }], remove: ['z'] } }),
    ],
    [
      'every tag removed',
      note({ tags: { remove: ['draft', 'env:prod', 'b', 'z', 'reviewed', 'health:ok'] } }),
    ],
  ]
}

function noteCalls2(ids: Ids): Asked[] {
  const note = (more: Message): Message => ({ workspaceId: W, documentIds: [ids.note], ...more })
  return [
    [
      'a symbol set on a note',
      {
        workspaceId: W,
        documentIds: [ids.styled],
        facets: { 'visual.symbol/v0': { kind: 'emoji', char: '\u{1F4CC}' } },
      },
    ],
    [
      'an unregistered facet passes through',
      {
        workspaceId: W,
        documentIds: [ids.loose],
        facets: { 'other.thing/v1': { 2: 'x', a: [true, null], b: 1 } },
      },
    ],
    ['a scalar facet passes through', note({ facets: { 'other.thing/v1': 1 } })],
    ['a facet merged beside the others', note({ facets: { 'other.second/v0': 'plain' } })],
    ['a facet deleted by null', note({ facets: { 'other.thing/v1': null } })],
    ['a facet deleted that is not there', note({ facets: { 'other.absent/v0': null } })],
    ['a target document named', note({ target: 'document', tags: { add: ['aimed'] } })],
    [
      'two notes at once',
      { workspaceId: W, documentIds: [ids.note, ids.second], tags: { add: ['batch'] } },
    ],
    [
      'a note twice',
      { workspaceId: W, documentIds: [ids.second, ids.second], tags: { add: ['twice'] } },
    ],
    ['by segment', { workspaceId: SEGMENT, documentIds: [ids.second], tags: { add: ['segment'] } }],
  ]
}

function noteCalls(ids: Ids): Asked[] {
  return [...noteCalls1(ids), ...noteCalls2(ids)]
}

function boardCalls1(ids: Ids): Asked[] {
  const board = (more: Message): Message => ({ workspaceId: W, documentIds: [ids.board], ...more })
  const node = (nodeId: string, more: Message) => board({ nodeId, ...more })
  const edge = (edgeId: string, more: Message) => board({ edgeId, ...more })
  return [
    ['a tag on the board', board({ tags: { add: ['board:one'] } })],
    ['a tag on the board by target', board({ target: 'canvas', tags: { add: ['board:two'] } })],
    ['a tag removed from the board', board({ tags: { remove: ['board:one'] } })],
    [
      'a theme on the canvas',
      board({ target: 'canvas', facets: { 'visual.theme/v0': { theme: 'visual.neon' } } }),
    ],
    [
      'a canvas theme with a tag',
      board({
        target: 'canvas',
        tags: { add: ['themed'] },
        facets: { 'visual.edges/v0': { routing: 'orthogonal' } },
      }),
    ],
    [
      'the last canvas facets deleted',
      board({ target: 'canvas', facets: { 'visual.theme/v0': null, 'visual.edges/v0': null } }),
    ],
    ['a tag on a node', node('pad', { tags: { add: ['north'] } })],
    ['a tag removed from a node', node('pad', { tags: { remove: ['plain', 'north'] } })],
    ['a facet on a node', node('tower', { facets: { 'visual.shape/v0': { kind: 'hexagon' } } })],
    [
      'a facet and a tag on a node',
      node('tower', {
        tags: { add: ['both'] },
        facets: { 'visual.shape/v0': { kind: 'cylinder' } },
      }),
    ],
    ['a facet deleted from a node', node('tower', { facets: { 'visual.shape/v0': null } })],
    ['a tag on an edge', edge('fuels', { tags: { add: ['pipe'] } })],
  ]
}

function boardCalls2(ids: Ids): Asked[] {
  const board = (more: Message): Message => ({ workspaceId: W, documentIds: [ids.board], ...more })
  const node = (nodeId: string, more: Message) => board({ nodeId, ...more })
  const edge = (edgeId: string, more: Message) => board({ edgeId, ...more })
  return [
    [
      'a facet on an edge',
      edge('fuels', { facets: { 'visual.edges/v0': { routing: 'orthogonal' } } }),
    ],
    ['a facet deleted from an edge', edge('fuels', { facets: { 'visual.edges/v0': null } })],
    ['a rename through the board', board({ tags: { rename: [{ from: 'plain', to: 'common' }] } })],
    [
      'a rename on one node',
      node('tower', { tags: { rename: [{ from: 'health:failing', to: 'health:down' }] } }),
    ],
    [
      'a rename that reaches nothing',
      board({ tags: { rename: [{ from: 'nothing', to: 'something' }] } }),
    ],
    [
      'a board with no elements',
      { workspaceId: W, documentIds: [ids.empty], tags: { add: ['bare'] } },
    ],
    [
      'a facet on a board by target and a tag together',
      {
        workspaceId: W,
        documentIds: [ids.empty],
        target: 'canvas',
        tags: { add: ['both'] },
        facets: { 'visual.theme/v0': { theme: 'visual.neon' } },
      },
    ],
  ]
}

function boardCalls(ids: Ids): Asked[] {
  return [...boardCalls1(ids), ...boardCalls2(ids)]
}

function refusedCalls1(ids: Ids): Asked[] {
  const board = (more: Message): Message => ({ workspaceId: W, documentIds: [ids.board], ...more })
  const note = (more: Message): Message => ({ workspaceId: W, documentIds: [ids.note], ...more })
  return [
    ['neither tags nor facets', { workspaceId: W, documentIds: [ids.note] }],
    ['a node and an edge', board({ nodeId: 'pad', edgeId: 'fuels', tags: { add: ['x'] } })],
    [
      'a node of two documents',
      { workspaceId: W, documentIds: [ids.board, ids.empty], nodeId: 'pad', tags: { add: ['x'] } },
    ],
    [
      'an edge of two documents',
      {
        workspaceId: W,
        documentIds: [ids.board, ids.empty],
        edgeId: 'fuels',
        tags: { add: ['x'] },
      },
    ],
    ['a node and the canvas', board({ nodeId: 'pad', target: 'canvas', tags: { add: ['x'] } })],
    ['an edge and the canvas', board({ edgeId: 'fuels', target: 'canvas', tags: { add: ['x'] } })],
    [
      'facets on a board without a target',
      board({ facets: { 'visual.theme/v0': { theme: 'visual.neon' } } }),
    ],
    ['the canvas of a note', note({ target: 'canvas', tags: { add: ['x'] } })],
    [
      'the canvas of a note, facets',
      note({ target: 'canvas', facets: { 'visual.theme/v0': { theme: 'visual.neon' } } }),
    ],
    ['a node of a note', note({ nodeId: 'pad', tags: { add: ['x'] } })],
    [
      'a node of a note holding the retired list',
      { workspaceId: W, documentIds: [ids.oldnote], nodeId: 'pad', tags: { add: ['x'] } },
    ],
    [
      'an edge of a note holding the retired list',
      { workspaceId: W, documentIds: [ids.oldnote], edgeId: 'fuels', tags: { add: ['x'] } },
    ],
    ['an edge of a note', note({ edgeId: 'fuels', tags: { add: ['x'] } })],
    ['a node the board lacks', board({ nodeId: 'ghost', tags: { add: ['x'] } })],
    ['an edge the board lacks', board({ edgeId: 'ghost', tags: { add: ['x'] } })],
  ]
}

function refusedCalls2(ids: Ids): Asked[] {
  const board = (more: Message): Message => ({ workspaceId: W, documentIds: [ids.board], ...more })
  return [
    [
      'a node of an empty board',
      { workspaceId: W, documentIds: [ids.empty], nodeId: 'pad', tags: { add: ['x'] } },
    ],
    ['a locked node', board({ nodeId: 'vault', tags: { add: ['x'] } })],
    [
      'a locked node, facets',
      board({ nodeId: 'vault', facets: { 'visual.shape/v0': { kind: 'hexagon' } } }),
    ],
    [
      'a rename reaching a locked edge',
      board({ tags: { rename: [{ from: 'wire', to: 'cable' }] } }),
    ],
    ['a locked edge', board({ edgeId: 'sealed', tags: { add: ['x'] } })],
    [
      'a rename reaching a locked node',
      board({ tags: { rename: [{ from: 'plain', to: 'common' }] } }),
    ],
    [
      'a rename not reaching the locked ones',
      board({ tags: { rename: [{ from: 'north', to: 'south' }] } }),
    ],
    [
      'a document the workspace lacks',
      { workspaceId: W, documentIds: [ids.note, NOTHING], tags: { add: ['x'] } },
    ],
    [
      'a workspace nothing answers to',
      { workspaceId: 'nope', documentIds: [ids.note], tags: { add: ['x'] } },
    ],
    [
      'another namespace',
      { workspaceId: `you/${SEGMENT}`, documentIds: [ids.note], tags: { add: ['x'] } },
    ],
    [
      'a kind mismatch later in the batch',
      { workspaceId: W, documentIds: [ids.note, ids.board], facets: { 'other.x/v0': 1 } },
    ],
  ]
}

function refusedCalls3(ids: Ids): Asked[] {
  const board = (more: Message): Message => ({ workspaceId: W, documentIds: [ids.board], ...more })
  const note = (more: Message): Message => ({ workspaceId: W, documentIds: [ids.note], ...more })
  return [
    [
      'a canvas on a note later in the batch',
      {
        workspaceId: W,
        documentIds: [ids.board, ids.note],
        target: 'canvas',
        tags: { add: ['x'] },
      },
    ],
    [
      'a payload the facet refuses',
      note({ facets: { 'visual.symbol/v0': { kind: 'emoji', char: '✅\u{1F525}' } } }),
    ],
    [
      'a facet under an old version',
      note({ facets: { 'visual.symbol/v9': { kind: 'emoji', char: 'a' } } }),
    ],
    ['a facet the target excludes', note({ facets: { 'visual.shape/v0': { kind: 'hexagon' } } })],
    [
      'a facet on the canvas the target excludes',
      board({ target: 'canvas', facets: { 'visual.symbol/v0': { kind: 'emoji', char: 'a' } } }),
    ],
    [
      'a theme nothing registered',
      board({ target: 'canvas', facets: { 'visual.theme/v0': { theme: 'visual.chalk' } } }),
    ],
    [
      'a payload with a key the schema drops',
      board({ nodeId: 'tower', facets: { 'visual.shape/v0': { kind: 'hexagon', extra: 1 } } }),
    ],
  ]
}

function refusedCalls4(ids: Ids): Asked[] {
  const board = (more: Message): Message => ({ workspaceId: W, documentIds: [ids.board], ...more })
  return [
    [
      'the first of two refused facets',
      board({
        nodeId: 'tower',
        facets: { 'visual.shape/v0': { kind: 'nope' }, 'visual.text/v0': 1 },
      }),
    ],
    ['a retired board', { workspaceId: W, documentIds: [ids.elderly], tags: { add: ['x'] } }],
    [
      'a retired board, a node',
      { workspaceId: W, documentIds: [ids.elderly], nodeId: 'e1', tags: { add: ['x'] } },
    ],
  ]
}

function refusedCalls(ids: Ids): Asked[] {
  return [
    ...refusedCalls1(ids),
    ...refusedCalls2(ids),
    ...refusedCalls3(ids),
    ...refusedCalls4(ids),
  ]
}

function limitCalls(ids: Ids): Asked[] {
  const crowded = (more: Message): Message => ({
    workspaceId: W,
    documentIds: [ids.crowded],
    ...more,
  })
  return [
    ['1024 tags on a note', crowded({ tags: { add: manyTags(1024) } })],
    ['one more than a note may carry', crowded({ tags: { add: ['over'] } })],
    ['a change that does not grow the set', crowded({ tags: { add: ['t1'], remove: ['t2'] } })],
    [
      'a rename that merges below the bound',
      crowded({ tags: { rename: [{ from: 't3', to: 't4' }] } }),
    ],
    ['an add of 1025 tags', crowded({ tags: { add: manyTags(1025, 'u') } })],
    ['a tag of 1025 characters', crowded({ tags: { add: ['a'.repeat(1025)] } })],
    [
      'a tag of 1024 characters',
      { workspaceId: W, documentIds: [ids.second], tags: { add: ['a'.repeat(1024)] } },
    ],
    [
      '50 documents',
      {
        workspaceId: W,
        documentIds: Array.from({ length: 50 }, () => ids.second),
        tags: { add: ['fifty'] },
      },
    ],
    [
      '51 documents',
      {
        workspaceId: W,
        documentIds: Array.from({ length: 51 }, () => ids.second),
        tags: { add: ['fifty'] },
      },
    ],
  ]
}

function fieldCalls1(ids: Ids): Asked[] {
  const note = (more: Message): Message => ({ workspaceId: W, documentIds: [ids.note], ...more })
  return [
    ['no arguments', undefined],
    ['empty arguments', {}],
    ['no documents', { workspaceId: W }],
    ['no documents at all', { workspaceId: W, documentIds: [], tags: { add: ['x'] } }],
    [
      'a lowercase document id',
      note({ documentIds: [ids.note?.toLowerCase()], tags: { add: ['x'] } }),
    ],
    ['a bad address', { workspaceId: 'a_b', documentIds: [ids.note], tags: { add: ['x'] } }],
    ['a string for the documents', { workspaceId: W, documentIds: ids.note, tags: { add: ['x'] } }],
    ['an empty node id', note({ nodeId: '', tags: { add: ['x'] } })],
    ['an empty edge id', note({ edgeId: '', tags: { add: ['x'] } })],
    ['an unknown target', note({ target: 'node', tags: { add: ['x'] } })],
    ['null for the target', note({ target: null, tags: { add: ['x'] } })],
    ['an empty tags object', note({ tags: {} })],
    ['tags naming nothing', note({ tags: { add: [], remove: [] } })],
    ['a string for the tags', note({ tags: 'x' })],
    ['a string for add', note({ tags: { add: 'x' } })],
    ['a number among the removals', note({ tags: { remove: ['x', 7] } })],
    ['an empty tag', note({ tags: { add: [''] } })],
    ['a colon that is not a scoped tag', note({ tags: { add: ['a:b:c'] } })],
    ['a scoped tag in capitals', note({ tags: { add: ['Health:ok'] } })],
    [
      'a rename entry with an unknown key',
      note({ tags: { rename: [{ from: 'a', to: 'b', extra: 1 }] } }),
    ],
    ['a rename entry missing a half', note({ tags: { rename: [{ from: 'a' }] } })],
    ['a rename to a colon tag', note({ tags: { rename: [{ from: 'a', to: 'x:y:z' }] } })],
    ['a rename from an empty name', note({ tags: { rename: [{ from: '', to: 'b' }] } })],
    ['an unknown key in tags', note({ tags: { add: ['x'], also: 1 } })],
    ['an array for the facets', note({ facets: [] })],
    ['a facet key off the pattern', note({ facets: { Bad: 1 } })],
    ['a facet key with no version digits', note({ facets: { 'a.b/v': 1 } })],
    ['a facet key with a version that is not digits', note({ facets: { 'a.b/v1x': 1 } })],
  ]
}

function fieldCalls2(ids: Ids): Asked[] {
  const note = (more: Message): Message => ({ workspaceId: W, documentIds: [ids.note], ...more })
  return [
    ['a facet key with no version', note({ facets: { 'a.b': 1 } })],
    ['a facet key with no dot', note({ facets: { 'a/v0': 1 } })],
    ['a facet key with two dots', note({ facets: { 'a.b.c/v0': 1 } })],
    ['a facet key in capitals', note({ facets: { 'A.b/v0': 1 } })],
    ['a facet key with a capital version', note({ facets: { 'a.b/V0': 1 } })],
    ['a facet key starting with a digit', note({ facets: { '1a.b/v0': 1 } })],
    ['a facet name starting with a digit', note({ facets: { 'a.1b/v0': 1 } })],
    ['a facet key with an underscore', note({ facets: { 'a_b.c/v0': 1 } })],
    ['a facet name with a capital inside', note({ facets: { 'a.bC/v0': 1 } })],
    ['an empty namespace', note({ facets: { '.b/v0': 1 } })],
    ['an empty facet name', note({ facets: { 'a./v0': 1 } })],
    [
      'a facet key of hyphens and digits',
      { workspaceId: W, documentIds: [ids.second], facets: { 'a-1.b-2/v10': 1 } },
    ],
    ['tags naming nothing beside a type error', note({ tags: { add: 'x', remove: [] } })],
    ['a tag list of the wrong type beside a name', note({ tags: { add: ['x'], remove: 3 } })],
    ['a rename list of the wrong type', note({ tags: { rename: 'x' } })],
    ['a rename entry of the wrong type', note({ tags: { rename: ['x'] } })],
    ['a rename entry missing both halves', note({ tags: { rename: [{}] } })],
    ['a null for the tags', note({ tags: null })],
    ['a null for the node id', note({ nodeId: null, tags: { add: ['x'] } })],
    ['a number for the edge id', note({ edgeId: 3, tags: { add: ['x'] } })],
    ['a core facet key', note({ facets: { tags: ['x'] } })],
    ['two facet keys off the pattern', note({ facets: { B: 2, a: 1 } })],
    ['a null for the facets', note({ facets: null })],
    ['an unknown key', note({ tags: { add: ['x'] }, follow: true })],
    [
      'every field wrong',
      { workspaceId: 1, documentIds: null, nodeId: 3, tags: 4, target: 5, facets: 6, extra: 7 },
    ],
  ]
}

function fieldCalls(ids: Ids): Asked[] {
  return [...fieldCalls1(ids), ...fieldCalls2(ids)]
}

/** The workspace's tag library and what it holds against a write. */
function libraryAddCalls(ids: Ids): Asked[] {
  const board = (more: Message): Message => ({ workspaceId: W, documentIds: [ids.board], ...more })
  return [
    [
      'a tag value the library does not admit',
      board({ nodeId: 'pad', tags: { add: ['region:asia'] } }),
    ],
    [
      'a tag value the library does not admit on an edge',
      board({ edgeId: 'fuels', tags: { add: ['region:asia'] } }),
    ],
    [
      'a second value under an exclusive key',
      board({ nodeId: 'pad', tags: { add: ['health:failing'] } }),
    ],
    ['a value the library admits', board({ nodeId: 'pad', tags: { add: ['region:eu'] } })],
    [
      'a rename through the board against the library',
      board({ tags: { rename: [{ from: 'plain', to: 'region:asia' }] } }),
    ],
    [
      'a note against the library',
      { workspaceId: W, documentIds: [ids.second], tags: { add: ['region:asia'] } },
    ],
    [
      'a batch refused on its second document',
      { workspaceId: W, documentIds: [ids.second, ids.board], tags: { add: ['region:asia'] } },
    ],
    ['a plain tag against the library', board({ nodeId: 'pad', tags: { add: ['anything'] } })],
  ]
}

function libraryRemovalCalls(ids: Ids): Asked[] {
  const board = (more: Message): Message => ({ workspaceId: W, documentIds: [ids.board], ...more })
  return [
    [
      'a rename through an unlocked board under the library',
      {
        workspaceId: W,
        documentIds: [ids['loose-board']],
        tags: { rename: [{ from: 'old', to: 'region:eu' }] },
      },
    ],
    ['a removal under the library', board({ nodeId: 'pad', tags: { remove: ['anything'] } })],
    [
      'a rename into a value the library does not admit',
      {
        workspaceId: W,
        documentIds: [ids.second],
        tags: { rename: [{ from: 'segment', to: 'region:asia' }] },
      },
    ],
    [
      'a board tag the library does not admit',
      { workspaceId: W, documentIds: [ids.empty], tags: { add: ['region:asia'] } },
    ],
    [
      'two values under an exclusive key on a board',
      { workspaceId: W, documentIds: [ids.empty], tags: { add: ['health:ok', 'health:failing'] } },
    ],
  ]
}

function libraryCalls(ids: Ids): Asked[] {
  return [...libraryAddCalls(ids), ...libraryRemovalCalls(ids)]
}

/** Builds the tag library document through the tool, as a caller would. */
const libraryDocument = (ids: Ids): Asked[] => [
  [
    'the library document written',
    {
      workspaceId: W,
      documentIds: [ids.tags],
      facets: {
        'visual.tags/v0': {
          keys: {
            health: { exclusive: true, values: { failing: {}, ok: {} } },
            region: { values: { eu: {}, us: {} } },
          },
        },
      },
    },
  ],
]

/**
 * The calls the Rust core leaves pending, last because the daemon writes for
 * them and nothing after them may read it: a stored facet payload of several
 * keys is read back in the order npm loro's hash map holds them, which a
 * native build cannot know; a note's facets and tags together change two of
 * its roots; and a facet that takes a stencil reads the workspace's stencil
 * library.
 */
function pendingCalls(ids: Ids): Asked[] {
  const board = (more: Message): Message => ({ workspaceId: W, documentIds: [ids.board], ...more })
  const note = (more: Message): Message => ({ workspaceId: W, documentIds: [ids.note], ...more })
  return [
    [
      'a tag on an edge of a board that is not locked',
      { workspaceId: W, documentIds: [ids['loose-board']], edgeId: 'link', tags: { add: ['old'] } },
    ],
    [
      'a rename reaching nodes and edges',
      {
        workspaceId: W,
        documentIds: [ids['loose-board']],
        tags: { rename: [{ from: 'old', to: 'older' }] },
      },
    ],
    [
      'a rename reaching nodes and edges under the library',
      {
        workspaceId: W,
        documentIds: [ids['loose-board']],
        tags: { rename: [{ from: 'older', to: 'region:us' }] },
      },
    ],
    ['a facet set to sit beside the stored one', note({ facets: { 'other.thing/v1': 2 } })],
    ['a tag beside two stored facets', note({ tags: { add: ['beside'] } })],
    [
      'a stored payload of two keys beside a new facet',
      { workspaceId: W, documentIds: [ids.styled], facets: { 'other.second/v0': 1 } },
    ],
    [
      'a stored payload of several keys, a tag written',
      { workspaceId: W, documentIds: [ids.loose], tags: { add: ['x'] } },
    ],
    [
      'facets and tags together on a note',
      note({ tags: { add: ['both'] }, facets: { 'other.both/v0': 1 } }),
    ],
    [
      'a stencil written',
      board({ nodeId: 'pad', facets: { 'visual.stencil/v0': { stencil: 'visual.datastore' } } }),
    ],
    [
      'a stencil nothing registered',
      board({ nodeId: 'pad', facets: { 'visual.stencil/v0': { stencil: 'workspace.nothing' } } }),
    ],
  ]
}

/** Reads back what the writes left, so a refused batch is seen to have kept nothing. */
const readBack = (documentId: string | undefined, about: string): Asked[] => [
  [about, { workspaceId: W, documentIds: [documentId], tags: { add: ['readback'] } }],
]

export function calls(ids: Ids): Asked[] {
  return [
    ...noteCalls(ids),
    ...boardCalls(ids),
    ...refusedCalls(ids),
    ...limitCalls(ids),
    ...fieldCalls(ids),
    ...libraryDocument(ids),
    ...libraryCalls(ids),
    ...readBack(ids.second, 'the second note after a refused batch'),
    ...pendingCalls(ids),
  ]
}
