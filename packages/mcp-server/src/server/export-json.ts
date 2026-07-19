import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { LoroDoc } from 'loro-crdt'
import { nanoid } from 'nanoid'
import { getDataDir } from './config.js'
import { getLogger } from './log.js'
import { validateOutputPath } from './output-path.js'
import { resolveParentedElements } from '../shared/resolve-parented-elements.js'
import { validateLoroRawElements } from '../shared/loro-raw-element.js'

// Re-exported so existing route imports (`import { ..., OutputPathError } from
// './export-json.js'`) keep compiling without churn.
export { OutputPathError } from './output-path.js'

const STRIP_CUSTOM_FIELDS = ['templateInstanceId'] as const

function stripTemplateInstanceId(
  elements: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return elements.map((el) => {
    const copy: Record<string, unknown> = { ...el }
    for (const key of STRIP_CUSTOM_FIELDS) delete copy[key]
    return copy
  })
}

function normalizeExportElements(
  rawElements: Array<Record<string, unknown>>,
  includeCustomFields: boolean,
): Array<Record<string, unknown>> {
  if (includeCustomFields) {
    // includeCustomFields returns raw rows without resolveParentedElements by design;
    // this branch is intentionally unvalidated (raw passthrough).
    return rawElements
  }
  const log = getLogger('export-json')
  const validated = validateLoroRawElements(rawElements, ({ index, error }) => {
    log.warning({ index, reason: error.issues[0]?.message }, 'dropped corrupt element')
  })
  return stripTemplateInstanceId(
    resolveParentedElements(validated) as Array<Record<string, unknown>>,
  )
}

async function resolveOutputPath(args: {
  workspaceId: string
  slug: string
  dataDir?: string
  outputPath?: string
  overwrite?: boolean
}): Promise<string> {
  if (args.outputPath !== undefined) {
    const exportsDir = join(args.dataDir ?? getDataDir(), args.workspaceId, 'exports')
    await validateOutputPath(args.outputPath, args.overwrite === true, exportsDir)
    return args.outputPath
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  // The millisecond timestamp alone is not unique: two exports issued fast
  // enough to land in the same millisecond would collide and the second
  // write would silently clobber the first. The random suffix guarantees
  // uniqueness regardless of call timing.
  const fileName = `${args.slug}-${timestamp}-${nanoid(6)}.excalidraw`
  const exportsDir = join(args.dataDir ?? getDataDir(), args.workspaceId, 'exports')
  return join(exportsDir, fileName)
}

export async function exportCanvasJsonDoc(args: {
  workspaceId: string
  slug: string
  doc: LoroDoc
  includeCustomFields?: boolean
  dataDir?: string
  outputPath?: string
  overwrite?: boolean
}): Promise<{ filePath: string; elementCount: number }> {
  const rawElements = args.doc.getMovableList('elements').toJSON() as Array<Record<string, unknown>>
  const elements = normalizeExportElements(rawElements, args.includeCustomFields === true)
  const payload = {
    type: 'excalidraw',
    version: 2,
    source: '@kamiazya/whiteboard',
    elements,
    appState: {},
    files: {},
  }

  const filePath = await resolveOutputPath(args)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(payload, null, 2))

  return { filePath, elementCount: elements.length }
}
