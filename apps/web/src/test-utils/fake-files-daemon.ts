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
import { type TagBearerKind, tagsInUse } from '@kamiazya/whiteboard-model'
import { readStencilLibrary, readTagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import { jsonResponse } from './json-response.js'

export interface FakeFilesDaemonRow {
  readonly path: string
  readonly kind: 'markdown' | 'spatial'
  readonly name?: string
  readonly body?: string
  readonly tags?: readonly string[]
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
  counter: number
}
type Body = Record<string, string | undefined>
type Handler = (state: State, match: RegExpMatchArray, body: Body) => Response

const notFound = () => jsonResponse({ title: 'Not found' }, 404)

// The contracts require canonical ULIDs.
function nextId(state: State): string {
  state.counter += 1
  return `0${String(state.counter).padStart(25, '0')}`
}

function tagsAnswer(state: State) {
  const facetsAt = (path: string) => state.rows.find((row) => row.path === path)?.facets as never
  const bearers = state.rows.map((row) => ({
    what: (row.kind === 'markdown' ? 'document' : 'board') as TagBearerKind,
    tags: row.tags ?? [],
  }))
  return {
    documents: state.rows
      .filter((row) => (row.tags ?? []).length > 0)
      .map((row) => ({ documentId: row.id, tags: [...(row.tags ?? [])] })),
    contents: [],
    inUse: tagsInUse(bearers),
    library: readTagLibrary(facetsAt('tags')),
    stencils: readStencilLibrary(facetsAt('stencils')),
  }
}

function renameSubtree(state: State, from: string, to: string): void {
  state.rows = state.rows.map((row) =>
    row.path === from || row.path.startsWith(`${from}/`)
      ? { ...row, path: `${to}${row.path.slice(from.length)}` }
      : row,
  )
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

const ROUTES: readonly { method: string; pattern: RegExp; handle: Handler }[] = [
  {
    method: 'GET',
    pattern: /^\/api\/workspaces\/[^/]+\/documents$/,
    handle: (state) =>
      jsonResponse({
        documents: state.rows.map((row) => ({
          id: row.id,
          path: row.path,
          kind: row.kind,
          ...(row.name === undefined ? {} : { displayName: row.name }),
        })),
      }),
  },
  {
    method: 'POST',
    pattern: /^\/api\/v1\/workspaces\/[^/]+\/documents$/,
    handle: (state, _match, body) => {
      const id = nextId(state)
      const row = { id, path: String(body.path), kind: body.kind as Row['kind'] }
      state.rows = [...state.rows, body.name === undefined ? row : { ...row, name: body.name }]
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
      setName(state, match[1] ?? '', body.name)
      return jsonResponse({ documents: {}, pinned: [] })
    },
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
    handle: () => jsonResponse({ documents: {}, pinned: [] }),
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
]

export function createFakeFilesDaemon(seed: {
  readonly rows: readonly FakeFilesDaemonRow[]
  readonly trashed: readonly Pick<FakeFilesDaemonRow, 'path' | 'kind'>[]
}): typeof globalThis.fetch {
  const state: State = { rows: [], trash: [], counter: 0 }
  state.rows = seed.rows.map((row) => ({ ...row, id: nextId(state) }))
  state.trash = seed.trashed.map((row) => ({ ...row, id: nextId(state), deletedAt: 1_700_000 }))

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    const path = decodeURIComponent(url.pathname)
    const method = init?.method ?? 'GET'
    const body: Body = init?.body === undefined ? {} : JSON.parse(String(init.body))
    for (const route of ROUTES) {
      const match = route.method === method ? path.match(route.pattern) : null
      if (match !== null) return route.handle(state, match, body)
    }
    return jsonResponse({ message: `unexpected ${method} ${path}` }, 500)
  }) as typeof globalThis.fetch
}
