/**
 * The calls `workspace-edit.oracle.test.ts` records, in order, by what each
 * one is about. Held apart from the recorder so neither outgrows the file
 * budget.
 *
 * Order matters: every call runs against what the calls before it left. The
 * calls a replay may leave pending and that WRITE in the daemon (a body, a
 * delete, a minted workspace, a move whose references follow) come last, so
 * no answered call is recorded over a write a replay did not make.
 */

const NOTHING = '01BX5ZZKBKACTAV9WEVGEMMVRZ'

type Message = Record<string, unknown>

type Ids = Record<string, string>

type Asked = [string, Message | undefined]

/** The workspace the recording holds, by its id and its segment. */
const held = { id: '', segment: '' }

const edit = (ops: unknown, more: Message = {}): Message => ({
  workspaceId: held.segment,
  ops,
  ...more,
})

const spatial = (path: string, more: Message = {}): Message => ({
  op: 'document.create',
  path,
  kind: 'spatial',
  ...more,
})
const move = (documentId: string | undefined, more: Message = {}): Message => ({
  op: 'document.move',
  documentId,
  ...more,
})
const folder = (path: string, name?: string): Message => ({
  op: 'folder.rename',
  path,
  ...(name === undefined ? {} : { name }),
})

/** Arguments the SDK refuses before the tool runs. */
function invalidCalls(ids: Ids): Asked[] {
  return [
    ['no arguments', undefined],
    ['no ops', { workspaceId: held.segment }],
    ['an empty batch', edit([])],
    ['a string for the ops', edit('ops')],
    ['an op naming no arm', edit([{ op: 'document.copy', documentId: ids.beta }])],
    ['an op that is no object', edit([7])],
    ['a stray key beside the ops', edit([folder('shelf', 'Shelf')], { mode: 'apply' })],
    ['a number for the workspace', { workspaceId: 7, ops: [folder('shelf')] }],
    ['an address of two slashes', { workspaceId: 'a/b/c', ops: [folder('shelf')] }],
    ['a string for createWorkspace', edit([folder('shelf')], { createWorkspace: 'yes' })],
    ['a blank actor', edit([folder('shelf')], { actor: '' })],
    ['an actor with a line break', edit([folder('shelf')], { actor: 'a\nb' })],
    ['a document id no ULID', edit([move('not-an-id', { name: 'x' })])],
    ['a missing document id', edit([{ op: 'document.move', name: 'x' }])],
    ['a path of an empty segment', edit([move(ids.beta, { path: 'a//b' })])],
    ['a number for a name', edit([move(ids.beta, { name: 3 })])],
    ['a stray key on a move', edit([move(ids.beta, { name: 'x', kind: 'spatial' })])],
    ['a folder name with a slash', edit([folder('shelf', 'a/b')])],
    ['a blank folder name', edit([folder('shelf', '  ')])],
    ['a missing folder path', edit([{ op: 'folder.rename', name: 'x' }])],
    ['a kind no create takes', edit([{ op: 'document.create', path: 'x', kind: 'table' }])],
    ['a body on a spatial create', edit([spatial('x', { markdown: 'body' })])],
    ['a create with no path', edit([{ op: 'document.create', kind: 'spatial' }])],
    ['a delete with a stray key', edit([{ op: 'document.delete', documentId: ids.beta, x: 1 }])],
  ]
}

/** Arguments the SDK refuses for a bound, a length, or more than one fault. */
function boundCalls(ids: Ids): Asked[] {
  return [
    ['more ops than a call takes', edit(Array.from({ length: 201 }, () => folder('shelf')))],
    ['an object with a length for the ops', edit({ length: 1 })],
    ['an object with no length for the ops', edit({ length: 0 })],
    ['an empty string for the ops', edit('')],
    [
      'as many ops as a call takes',
      edit(Array.from({ length: 200 }, () => ({ ...folder('shelf'), name: 7 }))),
    ],
    ['a name past its bound', edit([move(ids.beta, { name: 'n'.repeat(201) })])],
    ['an array for a name', edit([move(ids.beta, { name: [] })])],
    ['a name at its bound', edit([move('x', { name: 'n'.repeat(200) })])],
    [
      'a name of wide characters past its bound',
      edit([move('x', { name: '\u{1F600}'.repeat(200) })]),
    ],
    ['an object with a long length for a name', edit([move(ids.beta, { name: { length: 201 } })])],
    ['a path past its bound', edit([move(ids.beta, { path: 'p'.repeat(1025) })])],
    ['a folder name past its bound', edit([folder('shelf', 'f'.repeat(201))])],
    ['two faults in one op', edit([move('x', { name: 3 })])],
    ['a fault in each of two ops', edit([move('x', { name: 'a' }), folder('shelf', '/')])],
    ['a body with no document id', edit([{ op: 'document.set', markdown: 'x' }])],
    ['a body op with no body', edit([{ op: 'document.set', documentId: ids.beta }])],
    ['a number for a body', edit([{ op: 'document.set', documentId: ids.beta, markdown: 1 }])],
    [
      'a number for a create body',
      edit([{ op: 'document.create', path: 'x', kind: 'markdown', markdown: 1 }]),
    ],
    ['a create naming no kind', edit([{ op: 'document.create', path: 'x' }])],
  ]
}

/** Addresses nothing answers to, and the advice each is refused with. */
function addressCalls(): Asked[] {
  return [
    ['an unknown workspace read', { workspaceId: 'nowhere', ops: [folder('shelf')] }],
    ['an unknown workspace create', { workspaceId: 'nowhere', ops: [spatial('x')] }],
    [
      'an unknown id',
      { workspaceId: '01BX5ZZKBKACTAV9WEVGEMMVR0', ops: [folder('shelf', 'Shelf')] },
    ],
    ['another namespace', { workspaceId: 'them/notes', ops: [folder('shelf', 'Shelf')] }],
  ]
}

/** Folders named, renamed, cleared and refused. */
function folderCalls(): Asked[] {
  return [
    ['a folder named', edit([folder('folder', 'Projects')])],
    ['a folder named again alike', edit([folder('folder', 'Projects')])],
    ['a folder named under padding', edit([folder('folder', '  Work  ')])],
    ['a folder name another folder shows', edit([folder('folder', 'shelf')])],
    ['a folder name a sibling has, cased', edit([folder('folder', 'SHELF')])],
    ['a folder name cleared', edit([folder('folder')])],
    ['a path no folder stands at', edit([folder('nowhere', 'Gone')])],
    ['a document path for a folder', edit([folder('beta', 'Beta')])],
    ['a folder by id', { workspaceId: held.id, ops: [folder('shelf', 'Books')] }],
    ['a folder qualified', { workspaceId: `me/${held.segment}`, ops: [folder('shelf', 'Shelf')] }],
  ]
}

/** Documents renamed and moved where no reference follows. */
function moveCalls(ids: Ids): Asked[] {
  return [
    ['a rename', edit([move(ids.beta, { name: 'Beta Board' })])],
    ['a rename under padding', edit([move(ids.beta, { name: '  Beta  ' })])],
    ['a blank rename clears', edit([move(ids.beta, { name: '   ' })])],
    ['an empty rename clears', edit([move(ids.named, { name: '' })])],
    ['a rename to a sibling name', edit([move(ids.beta, { name: 'other doc' })])],
    ['a rename to its own name', edit([move(ids.other, { name: 'Other Doc' })])],
    ['a rename of nothing', edit([move(NOTHING, { name: 'x' })])],
    ['a move of nothing', edit([move(NOTHING, { path: 'x' })])],
    ['a move naming no target', edit([move(ids.beta)])],
    ['a move onto its own path', edit([move(ids.beta, { path: 'beta' })])],
    ['a move', edit([move(ids.beta, { path: 'board' })])],
    ['a move into a new folder', edit([move(ids.named, { path: 'kept/named' })])],
    ['a move out of a folder', edit([move(ids.named, { path: 'named' })])],
    ['a subtree move', edit([move(ids.deep, { path: 'deeper' })])],
    ['a move into its own subtree', edit([move(ids.deep, { path: 'deeper/leaf/x' })])],
    ['a move onto a taken path', edit([move(ids.other, { path: 'board' })])],
    ['a move and a rename', edit([move(ids.other, { path: 'other2', name: 'Second' })])],
    ['a move whose rename is refused', edit([move(ids.named, { path: 'named3', name: 'Second' })])],
    ['a move beside unrelated links', edit([move(ids.beta, { path: 'beta' })])],
    ['a move under padding', edit([move(ids.beta, { path: 'beta', name: ' Beta ' })])],
  ]
}

/** Spatial documents created. */
function createCalls(): Asked[] {
  return [
    ['a spatial create', edit([spatial('fresh')])],
    ['a named spatial create', edit([spatial('maps/one', { name: 'Map One' })])],
    ['a create onto a taken path', edit([spatial('fresh')])],
    ['a named create onto a taken path', edit([spatial('fresh', { name: 'Fresh Two' })])],
    ['a create under a sibling name', edit([spatial('maps/two', { name: 'map one' })])],
    ['a create with a blank name', edit([spatial('blank', { name: '  ' })])],
    ['a create with createWorkspace', edit([spatial('boot')], { createWorkspace: true })],
    ['two creates', edit([spatial('pair/a'), spatial('pair/b', { name: 'B' })])],
  ]
}

/** Batches: what stands when an op is refused, and ops of several kinds. */
function batchCalls(ids: Ids): Asked[] {
  return [
    [
      'a batch refused at its third op',
      edit([folder('shelf', 'Library'), move(ids.beta, { name: 'Gamma' }), move(NOTHING, {})]),
    ],
    [
      'a batch refused at its first op',
      edit([move(NOTHING, { name: 'x' }), folder('shelf', 'Never')]),
    ],
    [
      'a batch of every answered kind',
      edit([spatial('mixed'), folder('maps', 'Maps'), move(ids.other, { name: 'Third' })]),
    ],
    ['a batch refused after a create', edit([spatial('mixed2'), folder('nowhere', 'x')])],
    ['a batch with an actor', edit([folder('shelf', 'Shelf')], { actor: 'claude-code/2.1' })],
  ]
}

/** Calls a replay may leave pending that write nothing in the daemon. */
function quietCalls(ids: Ids): Asked[] {
  return [
    ['a delete of nothing', edit([{ op: 'document.delete', documentId: NOTHING }])],
    ['a body for nothing', edit([{ op: 'document.set', documentId: NOTHING, markdown: 'x' }])],
    [
      'a markdown create past a refused rename',
      edit([move(NOTHING, { name: 'x' }), { op: 'document.create', path: 'm', kind: 'markdown' }]),
    ],
    ['an id for a create', edit([spatial('x')], { workspaceId: ids.alpha })],
  ]
}

/**
 * Calls whose daemon answer writes what a replay may leave pending: last. A
 * delete that lands is not among them: the trash blob it evacuates the
 * document into is a snapshot whose digest differs from run to run.
 */
function writingCalls(ids: Ids): Asked[] {
  return [
    ['a markdown create', edit([{ op: 'document.create', path: 'note2', kind: 'markdown' }])],
    [
      'a markdown create with a body',
      edit([{ op: 'document.create', path: 'note3', kind: 'markdown', markdown: 'hi' }]),
    ],
    ['a body replaced', edit([{ op: 'document.set', documentId: ids.alpha, markdown: 'new' }])],
    [
      'a rename then a body',
      edit([
        move(ids.beta, { name: 'Pre' }),
        { op: 'document.set', documentId: ids.alpha, markdown: 'x' },
      ]),
    ],
    ['a referenced move', edit([move(ids.alpha, { path: 'alpha2' })])],
    ['a referenced subtree move', edit([move(ids['folder/child'], { path: 'folder/kid' })])],
    ['a delete with descendants', edit([{ op: 'document.delete', documentId: ids.deep }])],
    ['a minted workspace', { workspaceId: 'fresh-ws', createWorkspace: true, ops: [spatial('x')] }],
  ]
}

/** The calls the recording answers, in order, by what each one is about. */
export function calls(record: Message): Asked[] {
  const [id = ''] = Object.keys(record.snapshots as Message)
  const [segment = ''] = record.known as string[]
  Object.assign(held, { id, segment })
  const ids = record.ids as Ids
  return [
    ...invalidCalls(ids),
    ...boundCalls(ids),
    ...addressCalls(),
    ...folderCalls(),
    ...moveCalls(ids),
    ...createCalls(),
    ...batchCalls(ids),
    ...quietCalls(ids),
    ...writingCalls(ids),
  ]
}
