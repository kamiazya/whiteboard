/**
 * A stateful daemon for `createDaemonFilesSource`: the routes the source
 * reaches, answered from rows this module keeps, so a create or a rename is
 * visible to the next list the way it is against the real daemon.
 *
 * It exists for the conformance suite, which seeds one fixture through each
 * keeper's own path. The library and tag answers are derived with the SAME
 * plugin readers the daemon's tag route runs, so a malformed library degrades
 * here exactly where the daemon degrades it, and what the suite then measures
 * is the source's mapping of that answer.
 */
import {
  movesForPathChange,
  planReferenceRewrite,
  rewriteReferenceTargets,
} from '@kamiazya/whiteboard-codec'
import { type TagBearerKind, tagsInUse } from '@kamiazya/whiteboard-model'
import {
  readStencilLibrary,
  readTagLibrary,
  STENCIL_LIBRARY_PATH,
  TAG_LIBRARY_PATH,
} from '@kamiazya/whiteboard-plugin-visual'
import { splitBearerTags } from '@kamiazya/whiteboard-reference-graph'
import { jsonResponse } from './json-response.js'

export interface FakeFilesDaemonRow {
  readonly path: string
  readonly kind: 'markdown' | 'spatial'
  readonly name?: string
  readonly body?: string
  readonly tags?: readonly string[]
  readonly nodeTags?: readonly (readonly string[])[]
  readonly edgeTags?: readonly (readonly string[])[]
  readonly facets?: Record<string, unknown>
}

type Row = FakeFilesDaemonRow & { readonly id: string }
interface Trashed {
  readonly id: string
  readonly path: string
  readonly kind: 'markdown' | 'spatial'
  readonly deletedAt: number
}
interface State {
  rows: Row[]
  trash: Trashed[]
  /** Pinned document ids in pin order, so a pin survives a rename the way it does on the daemon. */
  pinned: string[]
  counter: number
}
type Body = Record<string, string | boolean | undefined>
type Handler = (state: State, match: RegExpMatchArray, body: Body) => Response

const notFound = () => jsonResponse({ title: 'Not found' }, 404)

// The contracts require canonical ULIDs.
function nextId(state: State): string {
  state.counter += 1
  return `0${String(state.counter).padStart(25, '0')}`
}

/** What a row carries, as the daemon's projection names the bearers. */
function bearersOf(row: Row): { what: TagBearerKind; tags: readonly string[] }[] {
  return [
    { what: row.kind === 'markdown' ? 'document' : 'board', tags: row.tags ?? [] },
    ...(row.nodeTags ?? []).map((tags) => ({ what: 'node' as const, tags })),
    ...(row.edgeTags ?? []).map((tags) => ({ what: 'edge' as const, tags })),
  ]
}

function tagsAnswer(state: State) {
  const facetsAt = (path: string) => state.rows.find((row) => row.path === path)?.facets as never
  const split = state.rows.map((row) => ({
    id: row.id,
    ...splitBearerTags(bearersOf(row).filter((bearer) => bearer.tags.length > 0)),
  }))
  return {
    documents: split
      .filter(({ own }) => own.length > 0)
      .map(({ id, own }) => ({ documentId: id, tags: own })),
    contents: split
      .filter(({ carried }) => carried.length > 0)
      .map(({ id, carried }) => ({ documentId: id, tags: carried })),
    inUse: tagsInUse(state.rows.flatMap(bearersOf)),
    library: readTagLibrary(facetsAt(TAG_LIBRARY_PATH)),
    stencils: readStencilLibrary(facetsAt(STENCIL_LIBRARY_PATH)),
  }
}

/**
 * A subtree move, and the follow pass the daemon's rename route runs after
 * it: the same codec plan over the listing before the move, applied to every
 * body.
 */
function renameSubtree(state: State, from: string, to: string): void {
  const before = state.rows.map((row) => ({ id: row.id, path: row.path }))
  const plan = planReferenceRewrite({
    entries: before,
    moves: movesForPathChange(before, from, to),
  })
  state.rows = state.rows.map((row) => {
    const moved =
      row.path === from || row.path.startsWith(`${from}/`)
        ? { ...row, path: `${to}${row.path.slice(from.length)}` }
        : row
    return moved.body === undefined
      ? moved
      : { ...moved, body: rewriteReferenceTargets(moved.body, plan) }
  })
}

function setPinned(state: State, path: string, pinned: boolean): Response {
  const row = state.rows.find((candidate) => candidate.path === path)
  if (row === undefined) return notFound()
  if (!pinned) state.pinned = state.pinned.filter((id) => id !== row.id)
  else if (!state.pinned.includes(row.id)) state.pinned = [...state.pinned, row.id]
  return jsonResponse(namesAnswer(state))
}

/** The names route's answer: pinned documents as paths, in pin order. */
function namesAnswer(state: State) {
  const pathOf = new Map(state.rows.map((row) => [row.id, row.path]))
  return {
    documents: {},
    pinned: state.pinned.flatMap((id) => {
      const path = pathOf.get(id)
      return path === undefined ? [] : [path]
    }),
  }
}

function setName(state: State, path: string, name: string | undefined): void {
  state.rows = state.rows.map((row) => {
    if (row.path !== path) return row
    const { name: _previous, ...rest } = row
    return name === undefined || name === '' ? rest : { ...rest, name }
  })
}

function restore(state: State, documentId: string): Response {
  const gone = state.trash.find((row) => row.id === documentId)
  if (gone === undefined) return notFound()
  state.trash = state.trash.filter((row) => row !== gone)
  state.rows = [...state.rows, { id: gone.id, path: gone.path, kind: gone.kind }]
  return jsonResponse({ restored: { documentId: gone.id, path: gone.path } })
}

function purge(state: State, documentId: string): Response {
  const gone = state.trash.find((row) => row.id === documentId)
  if (gone === undefined) return notFound()
  state.trash = state.trash.filter((row) => row !== gone)
  return jsonResponse({ purged: { documentId: gone.id } })
}

const ROUTES: readonly { method: string; pattern: RegExp; handle: Handler }[] = [
  {
    method: 'GET',
    pattern: /^\/api\/workspaces\/[^/]+\/documents$/,
    handle: (state) =>
      jsonResponse({
        documents: state.rows.map((row) => ({
          documentId: row.id,
          path: row.path,
          kind: row.kind,
          ...(row.name === undefined ? {} : { name: row.name }),
        })),
      }),
  },
  {
    method: 'POST',
    pattern: /^\/api\/v1\/workspaces\/[^/]+\/documents$/,
    handle: (state, _match, body) => {
      const id = nextId(state)
      const row = { id, path: String(body.path), kind: body.kind as Row['kind'] }
      state.rows = [
        ...state.rows,
        typeof body.name === 'string' ? { ...row, name: body.name } : row,
      ]
      return jsonResponse({ workspaceId: 'ws', documentId: id, path: body.path }, 201)
    },
  },
  {
    method: 'PUT',
    pattern: /\/documents\/(.+)\/path$/,
    handle: (state, match, body) => {
      renameSubtree(state, match[1] ?? '', String(body.path))
      return jsonResponse({ path: body.path })
    },
  },
  {
    method: 'PUT',
    pattern: /\/documents\/(.+)\/name$/,
    handle: (state, match, body) => {
      setName(state, match[1] ?? '', typeof body.name === 'string' ? body.name : undefined)
      return jsonResponse(namesAnswer(state))
    },
  },
  {
    method: 'PUT',
    pattern: /\/documents\/(.+)\/pin$/,
    handle: (state, match, body) => setPinned(state, match[1] ?? '', body.pinned === true),
  },
  {
    method: 'GET',
    pattern: /\/documents\/([^/]+)\/okf$/,
    handle: (state, match) => {
      const row = state.rows.find((candidate) => candidate.id === match[1])
      if (row === undefined) return notFound()
      const facets = row.facets === undefined ? {} : { facets: row.facets }
      return jsonResponse({
        markdown: row.body ?? '',
        body: row.body ?? '',
        frontmatter: { type: 'note', ...facets },
      })
    },
  },
  {
    method: 'GET',
    pattern: /\/document-tags$/,
    handle: (state) => jsonResponse(tagsAnswer(state)),
  },
  {
    method: 'GET',
    pattern: /\/names$/,
    handle: (state) => jsonResponse(namesAnswer(state)),
  },
  {
    method: 'GET',
    pattern: /\/trash$/,
    handle: (state) =>
      jsonResponse({
        entries: state.trash.map((row) => ({
          documentId: row.id,
          path: row.path,
          deletedAt: row.deletedAt,
        })),
      }),
  },
  {
    method: 'POST',
    pattern: /\/trash\/([^/]+)\/restore$/,
    handle: (state, match) => restore(state, match[1] ?? ''),
  },
  {
    method: 'DELETE',
    pattern: /\/trash\/([^/]+)$/,
    handle: (state, match) => purge(state, match[1] ?? ''),
  },
]

export function createFakeFilesDaemon(seed: {
  readonly rows: readonly FakeFilesDaemonRow[]
  readonly trashed: readonly Pick<FakeFilesDaemonRow, 'path' | 'kind'>[]
}): typeof globalThis.fetch {
  const state: State = { rows: [], trash: [], pinned: [], counter: 0 }
  state.rows = seed.rows.map((row) => ({ ...row, id: nextId(state) }))
  state.trash = seed.trashed.map((row) => ({ ...row, id: nextId(state), deletedAt: 1_700_000 }))

  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const path = decodeURIComponent(url.pathname)
    const method = init?.method ?? 'GET'
    const body: Body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    for (const route of ROUTES) {
      const match = route.method === method ? route.pattern.exec(path) : null
      if (match !== null) return Promise.resolve(route.handle(state, match, body))
    }
    return Promise.resolve(jsonResponse({ message: `unexpected ${method} ${path}` }, 500))
  }) as typeof globalThis.fetch
}
