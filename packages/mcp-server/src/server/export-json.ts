import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { LoroDoc } from 'loro-crdt'
import { DATA_DIR } from './config.js'
import { validateOutputPath } from './output-path.js'
import {
  resolveParentedElements,
  type ParentedElement,
} from '../shared/resolve-parented-elements.js'

// Re-exported so existing route imports (`import { ..., OutputPathError } from
// './export-json.js'`) keep compiling without churn.
export { OutputPathError } from './output-path.js'
export type { OutputPathErrorCode } from './output-path.js'

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
    return rawElements
  }
  return stripTemplateInstanceId(
    resolveParentedElements(
      rawElements as unknown as ParentedElement[],
    ) as unknown as Array<Record<string, unknown>>,
  )
}

async function resolveOutputPath(args: {
  sessionId: string
  slug: string
  dataDir?: string
  outputPath?: string
  overwrite?: boolean
}): Promise<string> {
  if (args.outputPath !== undefined) {
    await validateOutputPath(args.outputPath, args.overwrite === true)
    return args.outputPath
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const fileName = `${args.slug}-${timestamp}.excalidraw`
  const exportsDir = join(args.dataDir ?? DATA_DIR, args.sessionId, 'exports')
  return join(exportsDir, fileName)
}

export async function exportCanvasJsonDoc(args: {
  sessionId: string
  slug: string
  doc: LoroDoc
  includeCustomFields?: boolean
  dataDir?: string
  outputPath?: string
  overwrite?: boolean
}): Promise<{ filePath: string; elementCount: number }> {
  const rawElements = args.doc.getMovableList('elements').toJSON() as Array<
    Record<string, unknown>
  >
  const elements = normalizeExportElements(
    rawElements,
    args.includeCustomFields === true,
  )
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
