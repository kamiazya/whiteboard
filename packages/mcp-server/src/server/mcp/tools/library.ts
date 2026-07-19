import { readFile } from 'node:fs/promises'
import { nanoid } from 'nanoid'
import { LoroMap } from 'loro-crdt'
import { z } from 'zod'
import type { DaemonClient } from '../daemon-client.js'
import {
  type UserLibraryMetadataManifest,
  userLibraryMetadataManifestSchema,
} from '../../../shared/api-contracts/libraries.js'
import { validateExternalUrl } from '../../validators.js'
import { apiGetSnapshot, apiPostLoroUpdate } from './annotate.js'
import { assertCanvasExists } from './canvas-existence.js'
import { parseCanvasId } from './canvas-id.js'
import { resolveLibraryItem, type LibraryElement } from './resolve-library-item.js'
import { boundsSchema } from './shared-schemas.js'

export const libraryInstallOutputSchema = z.object({
  libraryUrl: z.string(),
  itemCount: z.number(),
  installedUrls: z.array(z.string()),
})

export const installedUrlsOutputSchema = z.object({
  installedUrls: z.array(z.string()),
})

export const libInsertItemOutputSchema = z.object({
  source: z.string(),
  itemIndex: z.number(),
  insertedCount: z.number(),
  elementIds: z.array(z.string()),
})

export const libraryListItemsOutputSchema = z.object({
  source: z.string(),
  itemCount: z.number(),
  items: z.array(
    z.object({
      index: z.number(),
      name: z.string().optional(),
      elementCount: z.number(),
      bbox: boundsSchema,
    }),
  ),
})

export const libraryInsertBatchOutputSchema = z.object({
  source: z.string(),
  insertedItemCount: z.number(),
  insertedElementCount: z.number(),
  items: z.array(
    z.object({
      itemIndex: z.number(),
      insertedCount: z.number(),
      elementIds: z.array(z.string()),
    }),
  ),
})

export const userLibrarySaveOutputSchema = z.object({
  name: z.string(),
  itemCount: z.number(),
})

export const userLibraryListOutputSchema = z.object({
  libraries: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      itemCount: z.number(),
    }),
  ),
})

export const userLibraryRemoveOutputSchema = z.object({
  removed: z.string(),
  remaining: z.array(z.string()),
})

export { userLibraryMetadataManifestSchema, type UserLibraryMetadataManifest }

// MCP tools for working with libraries.excalidraw.com-compatible .excalidrawlib
// payloads. Supports v1 and v2, listing item metadata and inserting cloned items
// onto the canvas with fresh ids and shifted coordinates.

// Zod is the single source of truth for the .excalidrawlib wire format so that
// attacker-controlled payloads fetched from external URLs are always validated
// before use — never cast directly.

const boundElementRefSchema = z.object({
  id: z.string(),
  type: z.string(),
})

const libraryElementSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    boundElements: z.array(boundElementRefSchema).nullish(),
    // .passthrough() retains arbitrary Excalidraw-proprietary fields (strokeStyle,
    // roughness, strokeColor, etc.) that vary by element type; strict enumeration
    // would reject valid real-world payloads fetched from external library URLs.
  })
  .passthrough()

const libraryItemV2Schema = z.object({
  id: z.string().optional(),
  status: z.string().optional(),
  name: z.string().optional(),
  elements: z.array(libraryElementSchema),
})

export const libraryPayloadV1Schema = z.object({
  type: z.literal('excalidrawlib'),
  version: z.literal(1),
  library: z.array(z.array(libraryElementSchema)),
})

export const libraryPayloadV2Schema = z.object({
  type: z.literal('excalidrawlib'),
  version: z.literal(2),
  libraryItems: z.array(libraryItemV2Schema),
})

type LibraryItemV2 = z.infer<typeof libraryItemV2Schema>

interface LibrarySourceArgs {
  libraryUrl?: string
  libraryPath?: string
  userLibraryName?: string
}

interface LibraryInsertBatchItem {
  itemIndex: number
  target: { x: number; y: number }
  groupAs?: string
  scale?: number
}

interface LibraryInsertBatchArgs extends LibrarySourceArgs {
  canvasId: string
  items: LibraryInsertBatchItem[]
  groupAs?: string
  scale?: number
}

function normalizeLibraryPayload(raw: unknown, label: string): LibraryItemV2[] {
  const v2 = libraryPayloadV2Schema.safeParse(raw)
  if (v2.success) return v2.data.libraryItems

  const v1 = libraryPayloadV1Schema.safeParse(raw)
  if (v1.success) return v1.data.library.map((elements) => ({ elements }))

  if (
    raw === null ||
    typeof raw !== 'object' ||
    (raw as { type?: unknown }).type !== 'excalidrawlib'
  ) {
    throw new Error(`Not an .excalidrawlib payload: ${label}`)
  }
  // Surface the version field in the error when present to help diagnosis.
  const version = 'version' in raw ? (raw as { version: unknown }).version : undefined
  throw new Error(`Unsupported or malformed .excalidrawlib payload (version ${version}): ${label}`)
}

async function fetchLibrary(url: string): Promise<LibraryItemV2[]> {
  const raw = await fetchExternalLibraryPayload(url)
  return normalizeLibraryPayload(raw, url)
}

async function fetchExternalLibraryPayload(url: string): Promise<unknown> {
  const safeUrl = await validateExternalUrl(url)
  const res = await fetch(safeUrl)
  if (!res.ok) {
    throw new Error(`Failed to fetch library: ${res.status} ${safeUrl}`)
  }
  return (await res.json()) as unknown
}

// Accept exactly one of libraryUrl, libraryPath, or userLibraryName.
async function loadLibrarySource(
  src: LibrarySourceArgs,
  client?: DaemonClient,
): Promise<LibraryItemV2[]> {
  const specified = [src.libraryUrl, src.libraryPath, src.userLibraryName].filter(
    (v) => v !== undefined && v !== null && v !== '',
  )
  if (specified.length === 0) {
    throw new Error('one of libraryUrl / libraryPath / userLibraryName is required')
  }
  if (specified.length > 1) {
    throw new Error('Specify only one of libraryUrl / libraryPath / userLibraryName')
  }
  if (src.libraryUrl) return fetchLibrary(src.libraryUrl)
  if (src.libraryPath) {
    const raw = JSON.parse(await readFile(src.libraryPath, 'utf-8'))
    return normalizeLibraryPayload(raw, src.libraryPath)
  }
  if (src.userLibraryName) {
    if (client === undefined) {
      throw new Error('userLibraryName requires a daemon-backed request')
    }
    const res = await client.request(
      `/api/user-libraries/${encodeURIComponent(src.userLibraryName)}`,
    )
    if (res.status === 404) {
      throw new Error(`User library not found: "${src.userLibraryName}"`)
    }
    if (!res.ok) {
      throw new Error(`Failed to load user library "${src.userLibraryName}": ${res.status}`)
    }
    const raw = (await res.json()) as unknown
    return normalizeLibraryPayload(raw, `user:${src.userLibraryName}`)
  }
  throw new Error('unreachable')
}

function sourceLabel(src: LibrarySourceArgs): string {
  return src.libraryUrl ?? src.libraryPath ?? `user:${src.userLibraryName}`
}

function appendElementsToDoc(
  doc: Awaited<ReturnType<typeof apiGetSnapshot>>,
  elements: LibraryElement[],
): void {
  const list = doc.getMovableList('elements')
  for (const el of elements) {
    const map = list.insertContainer(list.length, new LoroMap())
    for (const [k, v] of Object.entries(el)) {
      if (v === undefined) continue
      map.set(k, v as Parameters<LoroMap['set']>[1])
    }
  }
}

function withAssignedGroups(element: LibraryElement, groupIds: string[]): LibraryElement {
  if (groupIds.length === 0) return element
  const current = Array.isArray(element.groupIds)
    ? element.groupIds.filter((value): value is string => typeof value === 'string')
    : []
  const merged = [...new Set([...current, ...groupIds])]
  return { ...element, groupIds: merged }
}

function prepareBatchInsert(
  libraryItems: LibraryItemV2[],
  items: LibraryInsertBatchItem[],
  batchGroupAs: string | undefined,
  resolveScale: (spec: LibraryInsertBatchItem) => number,
): {
  insertedElements: LibraryElement[]
  results: Array<{ itemIndex: number; insertedCount: number; elementIds: string[] }>
} {
  const insertedElements: LibraryElement[] = []
  const results: Array<{ itemIndex: number; insertedCount: number; elementIds: string[] }> = []
  for (const spec of items) {
    if (spec.itemIndex < 0 || spec.itemIndex >= libraryItems.length) {
      throw new Error(`itemIndex ${spec.itemIndex} out of range [0, ${libraryItems.length})`)
    }
    const item = libraryItems[spec.itemIndex]
    const assignedGroups = [
      ...(batchGroupAs ? [batchGroupAs] : []),
      ...(spec.groupAs ? [spec.groupAs] : []),
    ]
    const cloned = resolveLibraryItem(
      item.elements,
      spec.target,
      () => nanoid(),
      resolveScale(spec),
    ).map((element) => withAssignedGroups(element, assignedGroups))
    insertedElements.push(...cloned)
    results.push({
      itemIndex: spec.itemIndex,
      insertedCount: cloned.length,
      elementIds: cloned.map((element) => element.id),
    })
  }
  return { insertedElements, results }
}

async function insertLibraryBatch(
  args: LibraryInsertBatchArgs,
  client: DaemonClient,
): Promise<{
  source: string
  insertedItemCount: number
  insertedElementCount: number
  items: Array<{ itemIndex: number; insertedCount: number; elementIds: string[] }>
}> {
  const { workspaceId, slug } = parseCanvasId(args.canvasId)
  await assertCanvasExists(client, workspaceId, slug)
  const items = await loadLibrarySource(args, client)
  let metadata: UserLibraryMetadataManifest | undefined
  const needsMetadata =
    args.userLibraryName !== undefined &&
    args.scale === undefined &&
    args.items.some((item) => item.scale === undefined)
  if (needsMetadata) {
    metadata = await loadUserLibraryMetadata(args.userLibraryName!, client)
  }
  const prepared = prepareBatchInsert(items, args.items, args.groupAs, (spec) =>
    requirePositiveScale(spec.scale ?? args.scale ?? metadata?.scales?.[String(spec.itemIndex)]),
  )
  const doc = await apiGetSnapshot(client, workspaceId, slug)
  const prevVV = doc.version()
  appendElementsToDoc(doc, prepared.insertedElements)
  doc.commit()
  const update = doc.export({ mode: 'update', from: prevVV })
  if (update.byteLength > 0) {
    await apiPostLoroUpdate(client, workspaceId, slug, update)
  }
  return {
    source: sourceLabel(args),
    insertedItemCount: prepared.results.length,
    insertedElementCount: prepared.insertedElements.length,
    items: prepared.results,
  }
}

async function readJsonOrThrow<T>(res: Response, fallback: string): Promise<T> {
  if (res.ok) {
    return (await res.json()) as T
  }
  const body = (await res.json().catch(() => null)) as { message?: string } | null
  throw new Error(body?.message ?? fallback)
}

async function loadUserLibraryMetadata(
  name: string,
  client: DaemonClient,
): Promise<UserLibraryMetadataManifest> {
  const res = await client.request(`/api/user-libraries/${encodeURIComponent(name)}/metadata`)
  return await readJsonOrThrow<UserLibraryMetadataManifest>(
    res,
    `Failed to load user library metadata "${name}": ${res.status}`,
  )
}

function requirePositiveScale(scale: number | undefined): number {
  if (scale === undefined) return 1
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error('scale must be a positive number')
  }
  return scale
}

function itemBBox(elements: LibraryElement[]): {
  x: number
  y: number
  width: number
  height: number
} {
  if (elements.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const el of elements) {
    if (el.x < minX) minX = el.x
    if (el.y < minY) minY = el.y
    if (el.x + el.width > maxX) maxX = el.x + el.width
    if (el.y + el.height > maxY) maxY = el.y + el.height
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

export const libraryListItemsInputShape = {
  libraryUrl: z.string().optional().describe('HTTPS URL to a .excalidrawlib file.'),
  libraryPath: z.string().optional().describe('Absolute path to a local .excalidrawlib file.'),
  userLibraryName: z
    .string()
    .optional()
    .describe('Name of a user library saved via user_library_save.'),
} satisfies z.ZodRawShape

export function libraryListItemsTool() {
  return {
    name: 'library_list_items',
    description:
      'List items in an Excalidraw library. Source is one of: libraryUrl (HTTPS, e.g. libraries.excalidraw.com), libraryPath (absolute local file), or userLibraryName (saved via user_library_save). Returns per-item metadata (index, name, element count, bbox).',
    // Derived from the Zod shape so the JSON-Schema view can never drift from
    // what registerToolWithAnnotations actually validates against.
    inputSchema: z.toJSONSchema(z.object(libraryListItemsInputShape)) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    },
    execute: async (
      args: {
        libraryUrl?: string
        libraryPath?: string
        userLibraryName?: string
      },
      client?: DaemonClient,
    ): Promise<z.infer<typeof libraryListItemsOutputSchema>> => {
      const items = await loadLibrarySource(args, client)
      return {
        source: sourceLabel(args),
        itemCount: items.length,
        items: items.map((item, index) => ({
          index,
          name: item.name,
          elementCount: item.elements.length,
          bbox: itemBBox(item.elements),
        })),
      }
    },
  }
}

export const libraryInsertItemInputShape = {
  canvasId: z.string().describe('Canvas ID in "{workspaceId}/{slug}" form.'),
  libraryUrl: z
    .string()
    .optional()
    .describe(
      'HTTPS URL to a .excalidrawlib file (e.g. libraries.excalidraw.com items). Pick exactly one of libraryUrl / libraryPath / userLibraryName.',
    ),
  libraryPath: z.string().optional().describe('Absolute path to a local .excalidrawlib file.'),
  userLibraryName: z
    .string()
    .optional()
    .describe(
      'Name of a user library saved via user_library_save (stored in ~/.whiteboard/.user-libraries/).',
    ),
  itemIndex: z
    .number()
    .describe(
      'Item index within the library (0-based). Use library_list_items first to discover what is at each index.',
    ),
  target: z
    .object({ x: z.number(), y: z.number() })
    .describe(
      'World coords for the top-left of the inserted item. Internal element ids are remapped to fresh ids.',
    ),
  scale: z
    .number()
    .optional()
    .describe('Scale multiplier (1.0 = original). Overrides metadata.scales when both are set.'),
} satisfies z.ZodRawShape

export function libraryInsertItemTool() {
  return {
    name: 'library_insert_item',
    description:
      'Insert a specific item from an Excalidraw library onto the canvas. Source is one of: libraryUrl / libraryPath / userLibraryName. The item is cloned with fresh element ids and shifted so its bbox top-left aligns with target. Internal references (containerId / boundElements / arrow bindings) are remapped. External references are dropped.',
    // Derived from the Zod shape so the JSON-Schema view can never drift from
    // what registerToolWithAnnotations actually validates against.
    inputSchema: z.toJSONSchema(z.object(libraryInsertItemInputShape)) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    },
    execute: async (
      args: {
        canvasId: string
        libraryUrl?: string
        libraryPath?: string
        userLibraryName?: string
        itemIndex: number
        target: { x: number; y: number }
        scale?: number
      },
      client: DaemonClient,
    ): Promise<z.infer<typeof libInsertItemOutputSchema>> => {
      const result = await insertLibraryBatch(
        {
          canvasId: args.canvasId,
          libraryUrl: args.libraryUrl,
          libraryPath: args.libraryPath,
          userLibraryName: args.userLibraryName,
          items: [{ itemIndex: args.itemIndex, target: args.target, scale: args.scale }],
        },
        client,
      )
      const inserted = result.items[0] ?? {
        itemIndex: args.itemIndex,
        insertedCount: 0,
        elementIds: [],
      }
      return {
        source: result.source,
        itemIndex: inserted.itemIndex,
        insertedCount: inserted.insertedCount,
        elementIds: inserted.elementIds,
      }
    },
  }
}

export const libraryInsertBatchInputShape = {
  canvasId: z.string().describe('Canvas ID (workspaceId/slug)'),
  libraryUrl: z.string().optional().describe('HTTPS URL to a .excalidrawlib file'),
  libraryPath: z.string().optional().describe('Absolute path to a local .excalidrawlib'),
  userLibraryName: z
    .string()
    .optional()
    .describe('Name of a user library saved via user_library_save.'),
  groupAs: z
    .string()
    .optional()
    .describe('Optional logical group id applied to every inserted element in the batch.'),
  scale: z
    .number()
    .optional()
    .describe(
      'Optional default scale multiplier applied to every inserted item. Item-level scale overrides this. When omitted for userLibraryName, metadata.scales[itemIndex] is used if present.',
    ),
  items: z
    .array(
      z.object({
        itemIndex: z.number().describe('Zero-based index of the item within the library.'),
        target: z
          .object({ x: z.number(), y: z.number() })
          .describe('Absolute canvas coordinate for the item bbox top-left.'),
        groupAs: z
          .string()
          .optional()
          .describe('Optional logical group id applied only to this item insertion.'),
        scale: z
          .number()
          .optional()
          .describe(
            'Optional scale multiplier for this item insertion. Overrides batch scale and metadata.scales[itemIndex].',
          ),
      }),
    )
    .min(1)
    .describe('Items to insert from the shared source.'),
} satisfies z.ZodRawShape

export function libraryInsertBatchTool() {
  return {
    name: 'library_insert_batch',
    description:
      'Insert multiple items from the same Excalidraw library onto a canvas in one snapshot/update cycle. Source is one of: libraryUrl / libraryPath / userLibraryName. Each item is cloned with fresh ids, shifted to its target, and may optionally receive batch-level or per-item groupAs labels.',
    // Derived from the Zod shape so the JSON-Schema view can never drift from
    // what registerToolWithAnnotations actually validates against.
    inputSchema: z.toJSONSchema(z.object(libraryInsertBatchInputShape)) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    },
    execute: async (
      args: LibraryInsertBatchArgs,
      client: DaemonClient,
    ): Promise<z.infer<typeof libraryInsertBatchOutputSchema>> => {
      if (args.scale !== undefined) requirePositiveScale(args.scale)
      if (args.items.length === 0) {
        return {
          source: sourceLabel(args),
          insertedItemCount: 0,
          insertedElementCount: 0,
          items: [],
        }
      }
      return await insertLibraryBatch(args, client)
    },
  }
}

// Three tools for persisting library URLs at the session level so the browser can
// restore the library panel after reloads.

export const libraryInstallInputShape = {
  libraryUrl: z
    .string()
    .describe(
      'HTTPS URL to a .excalidrawlib file. Persisted to the session config so the browser auto-restores it on reload. Validated by fetching once at install time.',
    ),
} satisfies z.ZodRawShape

export function libraryInstallTool(workspaceId: string) {
  return {
    name: 'library_install',
    description:
      'Register a library URL at the session level. The URL is persisted to disk so the browser auto-restores it on reload. Also validates by fetching the library once (count of items returned for confirmation).',
    // Derived from the Zod shape so the JSON-Schema view can never drift from
    // what registerToolWithAnnotations actually validates against.
    inputSchema: z.toJSONSchema(z.object(libraryInstallInputShape)) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    },
    execute: async (
      args: { libraryUrl: string },
      client: DaemonClient,
    ): Promise<z.infer<typeof libraryInstallOutputSchema>> => {
      // Verify the URL eagerly so broken sources fail here.
      const items = await fetchLibrary(args.libraryUrl)
      const res = await client.request(`/api/workspaces/${workspaceId}/libraries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: args.libraryUrl }),
      })
      if (!res.ok) {
        throw new Error(`Failed to install library: ${res.status}`)
      }
      const libs = (await res.json()) as { urls: string[] }
      return {
        libraryUrl: args.libraryUrl,
        itemCount: items.length,
        installedUrls: libs.urls,
      }
    },
  }
}

export const libraryUninstallInputShape = {
  libraryUrl: z.string().describe('Library URL previously registered via library_install.'),
} satisfies z.ZodRawShape

export function libraryUninstallTool(workspaceId: string) {
  return {
    name: 'library_uninstall',
    description: 'Remove a previously installed library URL from the session registry.',
    // Derived from the Zod shape so the JSON-Schema view can never drift from
    // what registerToolWithAnnotations actually validates against.
    inputSchema: z.toJSONSchema(z.object(libraryUninstallInputShape)) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    },
    execute: async (
      args: { libraryUrl: string },
      client: DaemonClient,
    ): Promise<z.infer<typeof installedUrlsOutputSchema>> => {
      const res = await client.request(`/api/workspaces/${workspaceId}/libraries`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: args.libraryUrl }),
      })
      if (!res.ok) {
        throw new Error(`Failed to uninstall library: ${res.status}`)
      }
      const libs = (await res.json()) as { urls: string[] }
      return { installedUrls: libs.urls }
    },
  }
}

export const libraryListInstalledInputShape = {} satisfies z.ZodRawShape

export function libraryListInstalledTool(workspaceId: string) {
  return {
    name: 'library_list_installed',
    description:
      'List library URLs that have been installed to this session (via library_install or the browser library dialog).',
    // Derived from the Zod shape so the JSON-Schema view can never drift from
    // what registerToolWithAnnotations actually validates against.
    inputSchema: z.toJSONSchema(z.object(libraryListInstalledInputShape)) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    },
    execute: async (
      _args: object,
      client: DaemonClient,
    ): Promise<z.infer<typeof installedUrlsOutputSchema>> => {
      const res = await client.request(`/api/workspaces/${workspaceId}/libraries`)
      if (!res.ok) {
        throw new Error(`Failed to list installed libraries: ${res.status}`)
      }
      const libs = (await res.json()) as { urls: string[] }
      return { installedUrls: libs.urls }
    },
  }
}

// Three tools for managing user-scoped .excalidrawlib files across sessions. They
// live under ~/.excalidraw/.user-libraries and cover personal icon sets, internal
// templates, or curated local copies of external libraries.

export const userLibrarySaveInputShape = {
  name: z.string().describe('Library name (letters / digits / hyphens / underscores / dots).'),
  fromUrl: z
    .string()
    .optional()
    .describe(
      'HTTPS URL of a .excalidrawlib to fetch and save locally (e.g. curate a catalog item).',
    ),
  content: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Raw .excalidrawlib JSON ({type, version, library or libraryItems}). Use instead of fromUrl.',
    ),
} satisfies z.ZodRawShape

export function userLibrarySaveTool() {
  return {
    name: 'user_library_save',
    description:
      'Save a user-level library to ~/.excalidraw/.user-libraries/{name}.excalidrawlib. Provide EITHER fromUrl (fetched and stored) OR content (raw .excalidrawlib JSON object). Same name overwrites. The saved library is usable via userLibraryName in library_list_items / library_insert_item across sessions.',
    // Derived from the Zod shape so the JSON-Schema view can never drift from
    // what registerToolWithAnnotations actually validates against.
    inputSchema: z.toJSONSchema(z.object(userLibrarySaveInputShape)) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    },
    execute: async (
      args: { name: string; fromUrl?: string; content?: unknown },
      client: DaemonClient,
    ): Promise<z.infer<typeof userLibrarySaveOutputSchema>> => {
      const hasUrl = !!args.fromUrl
      const hasContent = args.content !== undefined && args.content !== null
      if (hasUrl === hasContent) {
        throw new Error('Specify exactly one of fromUrl or content')
      }
      let payload: unknown
      if (hasUrl) {
        payload = await fetchExternalLibraryPayload(args.fromUrl!)
      } else {
        payload = args.content
      }
      // Lightweight format validation: check only the type field here.
      if (
        typeof payload !== 'object' ||
        payload === null ||
        (payload as { type?: string }).type !== 'excalidrawlib'
      ) {
        throw new Error('content is not a valid .excalidrawlib payload (missing type field)')
      }
      const res = await client.request(`/api/user-libraries/${encodeURIComponent(args.name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: payload }),
      })
      if (!res.ok) {
        throw new Error(`Failed to save user library: ${res.status}`)
      }
      return (await res.json()) as { name: string; itemCount: number }
    },
  }
}

export const userLibraryListInputShape = {} satisfies z.ZodRawShape

export function userLibraryListTool() {
  return {
    name: 'user_library_list',
    description:
      'List user-level libraries saved in ~/.excalidraw/.user-libraries/. Returns { name, path, itemCount } for each.',
    // Derived from the Zod shape so the JSON-Schema view can never drift from
    // what registerToolWithAnnotations actually validates against.
    inputSchema: z.toJSONSchema(z.object(userLibraryListInputShape)) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    },
    execute: async (
      _args: object,
      client: DaemonClient,
    ): Promise<z.infer<typeof userLibraryListOutputSchema>> => {
      const res = await client.request('/api/user-libraries')
      if (!res.ok) {
        throw new Error(`Failed to list user libraries: ${res.status}`)
      }
      return (await res.json()) as {
        libraries: Array<{ name: string; path: string; itemCount: number }>
      }
    },
  }
}

export const userLibraryRemoveInputShape = {
  name: z.string().describe('Library name previously saved via user_library_save.'),
} satisfies z.ZodRawShape

export function userLibraryRemoveTool() {
  return {
    name: 'user_library_remove',
    description: 'Delete a user-level library by name. No-op if not found.',
    // Derived from the Zod shape so the JSON-Schema view can never drift from
    // what registerToolWithAnnotations actually validates against.
    inputSchema: z.toJSONSchema(z.object(userLibraryRemoveInputShape)) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    },
    execute: async (
      args: { name: string },
      client: DaemonClient,
    ): Promise<z.infer<typeof userLibraryRemoveOutputSchema>> => {
      const res = await client.request(`/api/user-libraries/${encodeURIComponent(args.name)}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        throw new Error(`Failed to remove user library: ${res.status}`)
      }
      return (await res.json()) as { removed: string; remaining: string[] }
    },
  }
}

export const userLibraryMetadataGetInputShape = {
  name: z.string().describe('Library name previously saved via user_library_save.'),
} satisfies z.ZodRawShape

export function userLibraryMetadataGetTool() {
  return {
    name: 'user_library_metadata_get',
    description:
      'Load user-level library metadata from ~/.excalidraw/.user-libraries/{name}.meta.json. Returns an empty manifest with revision 0 when metadata has not been created yet.',
    // Derived from the Zod shape so the JSON-Schema view can never drift from
    // what registerToolWithAnnotations actually validates against.
    inputSchema: z.toJSONSchema(z.object(userLibraryMetadataGetInputShape)) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    },
    execute: async (
      args: { name: string },
      client: DaemonClient,
    ): Promise<z.infer<typeof userLibraryMetadataManifestSchema>> => {
      const res = await client.request(
        `/api/user-libraries/${encodeURIComponent(args.name)}/metadata`,
      )
      return await readJsonOrThrow<UserLibraryMetadataManifest>(
        res,
        `Failed to load user library metadata: ${res.status}`,
      )
    },
  }
}

export const userLibraryMetadataSetInputShape = {
  name: z.string().describe('Library name previously saved via user_library_save.'),
  revision: z
    .number()
    .describe('Current manifest revision (from user_library_metadata_get). Prevents lost updates.'),
  aliases: z
    .record(z.string(), z.number())
    .optional()
    .describe('itemIndex-keyed alias map to merge into the manifest.'),
  notes: z
    .record(z.string(), z.string())
    .optional()
    .describe('itemIndex-keyed note map to merge into the manifest.'),
  scales: z
    .record(z.string(), z.number())
    .optional()
    .describe('itemIndex-keyed default-scale map to merge into the manifest.'),
} satisfies z.ZodRawShape

export function userLibraryMetadataSetTool() {
  return {
    name: 'user_library_metadata_set',
    description:
      'Merge aliases / notes / scales into a user-level library metadata manifest. Requires the current revision and returns the updated manifest with revision + 1.',
    // Derived from the Zod shape so the JSON-Schema view can never drift from
    // what registerToolWithAnnotations actually validates against.
    inputSchema: z.toJSONSchema(z.object(userLibraryMetadataSetInputShape)) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    },
    execute: async (
      args: {
        name: string
        revision: number
        aliases?: Record<string, number>
        notes?: Record<string, string>
        scales?: Record<string, number>
      },
      client: DaemonClient,
    ): Promise<z.infer<typeof userLibraryMetadataManifestSchema>> => {
      const res = await client.request(
        `/api/user-libraries/${encodeURIComponent(args.name)}/metadata`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            revision: args.revision,
            ...(args.aliases === undefined ? {} : { aliases: args.aliases }),
            ...(args.notes === undefined ? {} : { notes: args.notes }),
            ...(args.scales === undefined ? {} : { scales: args.scales }),
          }),
        },
      )
      return await readJsonOrThrow<UserLibraryMetadataManifest>(
        res,
        `Failed to set user library metadata: ${res.status}`,
      )
    },
  }
}

export const userLibraryMetadataDeleteInputShape = {
  name: z.string().describe('Library name previously saved via user_library_save.'),
  revision: z
    .number()
    .describe('Current manifest revision (from user_library_metadata_get). Prevents lost updates.'),
  aliasKeys: z
    .array(z.string())
    .optional()
    .describe('itemIndex keys to remove from the alias map.'),
  noteKeys: z.array(z.string()).optional().describe('itemIndex keys to remove from the note map.'),
  scaleKeys: z
    .array(z.string())
    .optional()
    .describe('itemIndex keys to remove from the scale map.'),
} satisfies z.ZodRawShape

export function userLibraryMetadataDeleteTool() {
  return {
    name: 'user_library_metadata_delete',
    description:
      'Delete alias / note / scale keys from a user-level library metadata manifest. Requires the current revision and returns the updated manifest with revision + 1.',
    // Derived from the Zod shape so the JSON-Schema view can never drift from
    // what registerToolWithAnnotations actually validates against.
    inputSchema: z.toJSONSchema(z.object(userLibraryMetadataDeleteInputShape)) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    },
    execute: async (
      args: {
        name: string
        revision: number
        aliasKeys?: string[]
        noteKeys?: string[]
        scaleKeys?: string[]
      },
      client: DaemonClient,
    ): Promise<z.infer<typeof userLibraryMetadataManifestSchema>> => {
      const res = await client.request(
        `/api/user-libraries/${encodeURIComponent(args.name)}/metadata`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            revision: args.revision,
            ...(args.aliasKeys === undefined ? {} : { aliasKeys: args.aliasKeys }),
            ...(args.noteKeys === undefined ? {} : { noteKeys: args.noteKeys }),
            ...(args.scaleKeys === undefined ? {} : { scaleKeys: args.scaleKeys }),
          }),
        },
      )
      return await readJsonOrThrow<UserLibraryMetadataManifest>(
        res,
        `Failed to delete user library metadata: ${res.status}`,
      )
    },
  }
}
