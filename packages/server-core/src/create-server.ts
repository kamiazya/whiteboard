import { DocumentPathTakenError, isWorkspaceNotFoundError } from '@kamiazya/whiteboard-ports'
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { z } from 'zod'
import { type ApiErrorBody, errorBody, invalidRequestBody, issueText } from './api-errors.js'
import { factsCacheFor } from './references/content-source.js'
import { vectorCacheFor } from './search/document-vector-cache.js'
import { SEARCH_QUERY_KEYS, searchInputFromQuery, searchWireName } from './search-query.js'
import type { ServerDeps } from './server-deps.js'
import { backlinksInputSchema, computeBacklinks } from './tools/backlinks.js'
import { createBodyEditTool } from './tools/body-edit.js'
import { inTheCallersWords, unknownWorkspaceRefusal } from './tools/caller-refusals.js'
import { createCanvasEditTool } from './tools/canvas-edit.js'
import { createCanvasRenderSvgTool } from './tools/canvas-render-svg.js'
import { createCanvasSnapshotTool } from './tools/canvas-snapshot.js'
import { createCanvasViewTool } from './tools/canvas-view.js'
import {
  WorkspaceDocumentNotFoundError,
  WorkspaceNotFoundForCallerError,
  WorkspaceSegmentUnusableError,
} from './tools/document-crud.errors.js'
import {
  wbDocumentCreate,
  wbDocumentDelete,
  wbDocumentList,
  wbDocumentResolve,
} from './tools/document-crud.js'
import {
  WB_DOCUMENT_LIST_DESCRIPTION,
  wbDocumentCreateInputSchema,
  wbDocumentDeleteInputSchema,
  wbDocumentListInputSchema,
  wbDocumentListOutputSchema,
  wbDocumentResolveInputSchema,
} from './tools/document-crud.schemas.js'
import { createDocumentGetTool } from './tools/document-get.js'
import { SnapshotNotFoundError } from './tools/document-io.js'
import {
  createDocumentSearchTool,
  documentSearchInputSchema,
  SearchNeedsQueryOrFilterError,
} from './tools/document-search.js'
import { OKF_YAML_SAFE_STAGE, OkfParseError } from './tools/document-set.js'
import { computeDocumentTags, documentTagsInputSchema } from './tools/document-tags.js'
import { DocumentKindMismatchError } from './tools/errors.js'
import { exportOkf, exportOkfInputSchema } from './tools/export-okf.js'
import { createFacetListTool } from './tools/facet-list.js'
import { createFacetSetTool } from './tools/facet-set.js'
import {
  linkifyMentions,
  linkifyMentionsInputSchema,
  NamelessLinkifyTargetError,
} from './tools/linkify-mentions.js'
import { TagLibraryError } from './tools/tag-library.js'
import { createThreadEditTool } from './tools/thread-edit.js'
import { createVersionListTool } from './tools/version-list.js'
import { createVersionRestoreTool } from './tools/version-restore.js'
import { createVersionSaveTool } from './tools/version-save.js'
import { createViewportSetTool } from './tools/viewport-set.js'
import { createWorkspaceEditTool } from './tools/workspace-edit.js'
import { resolveWorkspaceId, withResolvedWorkspaceHandles } from './workspace-handle.js'

/**
 * The URL names the workspace and the document a write is about; the body
 * may not. These routes parse with the TOOL inputs, which carry both ids
 * because a tool has no URL — and composed with the body spread last, a
 * body's own `workspaceId` won over the URL's, past a membership gate that
 * had judged the URL's workspace. The ids are now written after the body,
 * and a body that names either is refused by name rather than silently
 * overridden, so the caller learns the key has no place here instead of
 * sending it again.
 */
const URL_IDENTITY_KEYS = ['workspaceId', 'documentId'] as const

function identityNamedBy(body: object): ApiErrorBody | undefined {
  const named = URL_IDENTITY_KEYS.filter((key) => key in body)
  if (named.length === 0) return undefined
  return errorBody(
    'invalid_request',
    `${named.join(' and ')} ${named.length === 1 ? 'is' : 'are'} named by the URL, not the body`,
  )
}

/**
 * The fields a write's JSON body carries, or the refusal to answer with.
 *
 * A body that is not JSON is refused as that: reading it as `{}` made a
 * truncated body which DID carry `kind` come back as "Invalid discriminator
 * value", naming a field the caller had sent. JSON that is not an object (a
 * string, an array, `null`) has no fields to spread, so the schema is left to
 * name what is missing.
 */
async function readWriteBody(
  c: Context,
): Promise<{ body: Record<string, unknown> } | { refusal: ApiErrorBody }> {
  let json: unknown
  try {
    json = await c.req.json()
  } catch {
    return { refusal: errorBody('invalid_body', 'the request body is not valid JSON') }
  }
  const body = json !== null && typeof json === 'object' && !Array.isArray(json) ? json : {}
  const smuggled = identityNamedBy(body)
  return smuggled ? { refusal: smuggled } : { body: { ...body } }
}

/**
 * A GET route reads the query keys it declares and refuses the rest. Ignoring
 * one reads as success while the filter the caller meant never applied (`tags`
 * for `tag` answered every document), which is the failure a daemon's strict
 * bodies already refuse — a caller must learn its value did not take effect.
 */
function readsQuery(allowed: readonly string[]): MiddlewareHandler {
  return async (c, next) => {
    const unknown = Object.keys(c.req.queries()).filter((key) => !allowed.includes(key))
    if (unknown.length === 0) return next()
    const read =
      allowed.length === 0 ? 'this route reads no query string' : `it reads ${allowed.join(', ')}`
    return c.json(
      errorBody(
        'invalid_request',
        `unknown query parameter ${unknown.map((key) => `"${key}"`).join(', ')}; ${read}`,
      ),
      400,
    )
  }
}

/**
 * The search route's refusals in the query string's own spelling: the input
 * schema is the tool's (`query`, `tags`), and a caller of the URL never typed
 * either.
 */
function invalidSearchRequestBody(error: z.ZodError): ApiErrorBody {
  const reasons = error.issues.map((issue) =>
    issueText({
      ...issue,
      path: issue.path.map((part, at) => (at === 0 ? searchWireName(String(part)) : part)),
    }),
  )
  return errorBody('invalid_request', reasons.join('; '))
}

/** `POST …/documents` can create the workspace it names (`createWorkspace`), so it cannot be refused for lacking one here. */
const MAY_MINT_WORKSPACE = /^POST \/api\/v1\/workspaces\/[^/]+\/documents$/

type RouteContext = Context<{ Variables: { workspaceId: string } }>

/**
 * The workspace handle is resolved HERE, once per request, and every handler
 * reads the result rather than the raw path parameter.
 *
 * Middleware rather than a call in each handler: resolving twice in one
 * request is the failure this ordering exists to prevent — everything
 * downstream keys on the resolved id (write locks, document caches, sync
 * docKeys), and two independent resolutions can disagree the moment a
 * segment moves between workspaces mid-flight.
 *
 * A handle nothing answers to is refused in the one voice the tools use: a
 * route that let the lookup fail on its own said it differently (advice to
 * ADD, the id the caller never typed). A create is the one request that may
 * name a workspace it is about to make.
 */
function resolvesWorkspace(deps: ServerDeps): MiddlewareHandler<{
  Variables: { workspaceId: string }
}> {
  return async (c, next) => {
    const handle = c.req.param('workspaceId')
    const workspaceId = await resolveWorkspaceId(deps.documentIndex, handle)
    const unresolved =
      workspaceId === handle &&
      !MAY_MINT_WORKSPACE.test(`${c.req.method} ${c.req.path}`) &&
      (await deps.documentIndex.resolveWorkspace(handle)) === null
    if (unresolved) {
      const refusal = await unknownWorkspaceRefusal(handle, deps.knownWorkspaceHandles)
      return c.json(errorBody('workspace_not_found', refusal.message), 404)
    }
    c.set('workspaceId', workspaceId)
    await next()
  }
}

/**
 * A refusal in the words the caller used: its handle, not the id the handle
 * resolved to. The status follows the ORIGINAL error's class — re-saying a
 * message builds a plain `Error`, which no class check would recognise.
 */
function refusingIn(deps: ServerDeps) {
  return async (c: RouteContext, err: unknown) => {
    const said = await inTheCallersWords(err, {
      index: deps.documentIndex,
      handle: c.req.param('workspaceId') ?? '',
      workspaceId: c.get('workspaceId'),
      documentId: c.req.param('documentId'),
    })
    const cause = said instanceof WorkspaceDocumentNotFoundError ? said : err
    return mapDocumentError(c, cause, said instanceof Error ? said.message : undefined)
  }
}

export function createServer(deps: ServerDeps) {
  const app = new Hono<{ Variables: { workspaceId: string } }>()
  // The stamp-validated facts cache is held by the deps, not this server: /mcp
  // builds a server per request, which would otherwise search from an empty
  // cache. Backlinks, tags and search share it, whichever write path changed a document.
  const factsCache = factsCacheFor(deps)

  app.use('/api/v1/workspaces/:workspaceId/*', resolvesWorkspace(deps))
  const refuse = refusingIn(deps)

  app.post('/api/v1/workspaces/:workspaceId/documents', async (c) => {
    const read = await readWriteBody(c)
    if ('refusal' in read) return c.json(read.refusal, 400)
    const parsed = wbDocumentCreateInputSchema.safeParse({
      ...read.body,
      workspaceId: c.get('workspaceId'),
    })
    if (!parsed.success) {
      return c.json(invalidRequestBody(parsed.error), 400)
    }
    try {
      const result = await wbDocumentCreate(deps, parsed.data)
      return c.json(result, 201)
    } catch (err) {
      return refuse(c, err)
    }
  })

  app.get('/api/v1/workspaces/:workspaceId/documents', readsQuery([]), async (c) => {
    const parsed = wbDocumentListInputSchema.safeParse({ workspaceId: c.get('workspaceId') })
    if (!parsed.success) {
      return c.json(invalidRequestBody(parsed.error), 400)
    }
    try {
      const result = await wbDocumentList(deps, parsed.data)
      return c.json(result, 200)
    } catch (err) {
      return refuse(c, err)
    }
  })

  app.get('/api/v1/workspaces/:workspaceId/documents/:documentId', readsQuery([]), async (c) => {
    const parsed = wbDocumentResolveInputSchema.safeParse({
      workspaceId: c.get('workspaceId'),
      documentId: c.req.param('documentId'),
    })
    if (!parsed.success) {
      return c.json(invalidRequestBody(parsed.error), 400)
    }
    try {
      const result = await wbDocumentResolve(deps, parsed.data)
      return c.json(result, 200)
    } catch (err) {
      return refuse(c, err)
    }
  })

  app.delete('/api/v1/workspaces/:workspaceId/documents/:documentId', async (c) => {
    const parsed = wbDocumentDeleteInputSchema.safeParse({
      workspaceId: c.get('workspaceId'),
      documentId: c.req.param('documentId'),
    })
    if (!parsed.success) {
      return c.json(invalidRequestBody(parsed.error), 400)
    }
    try {
      const result = await wbDocumentDelete(deps, parsed.data)
      return c.json(result, 200)
    } catch (err) {
      return refuse(c, err)
    }
  })

  app.get('/api/v1/workspaces/:workspaceId/search', readsQuery(SEARCH_QUERY_KEYS), async (c) => {
    const parsed = documentSearchInputSchema.safeParse({
      workspaceId: c.get('workspaceId'),
      ...searchInputFromQuery({
        one: (name) => c.req.query(name),
        all: (name) => c.req.queries(name),
      }),
    })
    if (!parsed.success) {
      return c.json(invalidSearchRequestBody(parsed.error), 400)
    }
    try {
      return c.json(await tools.documentSearch.execute(parsed.data))
    } catch (err) {
      if (err instanceof SearchNeedsQueryOrFilterError) {
        return c.json(
          errorBody(
            'search_needs_query_or_filter',
            'Nothing to search for: pass `q` (words to match), or `tag` / `kind` (a filter to answer alone), or both.',
          ),
          400,
        )
      }
      return refuse(c, err)
    }
  })

  app.get('/api/v1/workspaces/:workspaceId/document-tags', readsQuery([]), async (c) => {
    const parsed = documentTagsInputSchema.safeParse({ workspaceId: c.get('workspaceId') })
    if (!parsed.success) {
      return c.json(invalidRequestBody(parsed.error), 400)
    }
    try {
      return c.json(await computeDocumentTags(deps, parsed.data, factsCache))
    } catch (err) {
      return refuse(c, err)
    }
  })

  app.post('/api/v1/workspaces/:workspaceId/documents/:documentId/linkify-mentions', async (c) => {
    const read = await readWriteBody(c)
    if ('refusal' in read) return c.json(read.refusal, 400)
    const parsed = linkifyMentionsInputSchema.safeParse({
      ...read.body,
      workspaceId: c.get('workspaceId'),
      documentId: c.req.param('documentId'),
    })
    if (!parsed.success) {
      return c.json(invalidRequestBody(parsed.error), 400)
    }
    try {
      return c.json(await linkifyMentions(deps, parsed.data))
    } catch (err) {
      if (err instanceof NamelessLinkifyTargetError) {
        return c.json(errorBody('nameless_link_target', err.message), 400)
      }
      return refuse(c, err)
    }
  })

  app.get(
    '/api/v1/workspaces/:workspaceId/documents/:documentId/backlinks',
    readsQuery([]),
    async (c) => {
      const parsed = backlinksInputSchema.safeParse({
        workspaceId: c.get('workspaceId'),
        documentId: c.req.param('documentId'),
      })
      if (!parsed.success) {
        return c.json(invalidRequestBody(parsed.error), 400)
      }
      try {
        return c.json(await computeBacklinks(deps, parsed.data, factsCache))
      } catch (err) {
        return refuse(c, err)
      }
    },
  )

  // Read-only OKF projection of one markdown document, over HTTP so a browsing
  // UI (workspace file tree) can open one without an MCP client; a spatial
  // document is refused as `wb_document_get` would not read it as OKF either.
  app.get(
    '/api/v1/workspaces/:workspaceId/documents/:documentId/okf',
    readsQuery([]),
    async (c) => {
      const parsed = exportOkfInputSchema.safeParse({
        workspaceId: c.get('workspaceId'),
        documentId: c.req.param('documentId'),
      })
      if (!parsed.success) {
        return c.json(invalidRequestBody(parsed.error), 400)
      }
      try {
        const result = await exportOkf(deps, parsed.data)
        return c.json(result, 200)
      } catch (err) {
        return refuse(c, err)
      }
    },
  )

  const tools = {
    // The document READ operations are exposed HERE as tool objects, not only
    // as the bare functions the routes above call. An MCP registration that
    // reaches for the operation instead sits OUTSIDE the record
    // `withResolvedWorkspaceHandles` wraps — so it never resolves a segment,
    // which is invisible for as long as a workspace's id and its handle are
    // the same string, and becomes "workspace not found" the moment ADR-0019's
    // mint makes them differ. The routes are unaffected: they resolve once in
    // the middleware above and pass the canonical id straight to the operation.
    //
    // Create, set and delete have no entry of their own: `wb_workspace_edit`
    // is the single front door onto them and carries each as an op, so the
    // record holds the batch rather than the batch AND three singletons.
    // The operations themselves are unchanged — the routes above still call
    // `wbDocumentCreate` / `wbDocumentDelete` directly, and the batch calls
    // them plus `createDocumentSetTool`.
    documentList: {
      name: 'wb_document_list' as const,
      description: WB_DOCUMENT_LIST_DESCRIPTION,
      inputSchema: wbDocumentListInputSchema,
      outputSchema: wbDocumentListOutputSchema,
      execute: (input: z.infer<typeof wbDocumentListInputSchema>) => wbDocumentList(deps, input),
    },
    workspaceEdit: createWorkspaceEditTool(deps),
    facetList: createFacetListTool(deps),
    facetSet: createFacetSetTool(deps),
    bodyEdit: createBodyEditTool(deps),
    canvasRenderSvg: createCanvasRenderSvgTool(deps),
    canvasView: createCanvasViewTool(deps),
    canvasSnapshot: createCanvasSnapshotTool(deps),
    canvasEdit: createCanvasEditTool(deps),
    threadEdit: createThreadEditTool(deps),
    viewportSet: createViewportSetTool(deps),
    documentGet: createDocumentGetTool(deps),
    documentSearch: createDocumentSearchTool(deps, vectorCacheFor(deps)),
    versionSave: createVersionSaveTool(deps),
    versionList: createVersionListTool(deps),
    versionRestore: createVersionRestoreTool(deps),
  }
  return {
    app,
    tools: withResolvedWorkspaceHandles(tools, deps.documentIndex, deps.knownWorkspaceHandles),
  }
}

interface Refusal {
  readonly matches: (err: unknown) => boolean
  readonly code: (err: unknown) => string
  readonly status: 400 | 404 | 409
}

const refusalOf = (
  cls: abstract new (...args: never[]) => Error,
  code: string | ((err: never) => string),
  status: Refusal['status'],
): Refusal => ({
  matches: (err) => err instanceof cls,
  code: typeof code === 'string' ? () => code : (err) => code(err as never),
  status,
})

/**
 * The errors a route answers rather than lets escape, in the order they are
 * tried. Each is a request that is well-formed to a server that is fine: only
 * the caller can send something the operation admits, so none is a 500.
 */
const REFUSALS: readonly Refusal[] = [
  refusalOf(WorkspaceDocumentNotFoundError, 'document_not_found', 404),
  // A document created and indexed but never written has no stored bytes —
  // a read miss, and not a workspace-level one.
  refusalOf(SnapshotNotFoundError, 'document_not_found', 404),
  // The route reads one format; a document in the other is a conflict with
  // what it is, which only reading it by its own kind resolves.
  refusalOf(DocumentKindMismatchError, 'document_kind_mismatch', 409),
  // The tool layer's own error carries advice for an MCP caller; the index's
  // spelling of the same condition escapes untranslated from tools that call
  // `documentIndex.listDocuments` directly (backlinks, document-tags), and a
  // typo'd workspaceId must read as 404, not 500.
  {
    matches: (err) =>
      err instanceof WorkspaceNotFoundForCallerError || isWorkspaceNotFoundError(err),
    code: () => 'workspace_not_found',
    status: 404,
  },
  refusalOf(DocumentPathTakenError, 'document_path_taken', 409),
  // The caller asked to create a workspace under a handle that cannot be a
  // segment (ADR-0019): the NAME is the problem, and only the caller can pick
  // another one.
  refusalOf(WorkspaceSegmentUnusableError, 'workspace_segment_unusable', 400),
  // A markdown body the schema admits (any string) that OKF cannot parse: the
  // reason names the stage, and only the caller can supply a body that
  // reaches the next one. A value YAML cannot carry has a code of its own, so
  // a client can tell "fix this value" from "this is not OKF".
  refusalOf(
    OkfParseError,
    (err: OkfParseError) =>
      err.stage === OKF_YAML_SAFE_STAGE ? 'okf_not_yaml_safe' : 'okf_parse_failed',
    400,
  ),
  // A tag the workspace's own library does not admit (ADR-0040 decision 5);
  // the message names the ones it does.
  refusalOf(TagLibraryError, 'tag_not_in_library', 400),
]

/** `said` is the reason as the caller's own words re-state it; the error's own message otherwise. */
function mapDocumentError(c: Context, err: unknown, said?: string) {
  const refusal = REFUSALS.find((candidate) => candidate.matches(err))
  if (refusal === undefined) throw err
  return c.json(errorBody(refusal.code(err), said ?? (err as Error).message), refusal.status)
}
