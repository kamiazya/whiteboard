import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { LoroDoc } from 'loro-crdt'
import { DATA_DIR } from './config.js'
import {
  resolveParentedElements,
  type ParentedElement,
} from '../shared/resolve-parented-elements.js'

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

export async function exportCanvasJsonDoc(args: {
  sessionId: string
  slug: string
  doc: LoroDoc
  includeCustomFields?: boolean
  dataDir?: string
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

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const fileName = `${args.slug}-${timestamp}.excalidraw`
  const exportsDir = join(args.dataDir ?? DATA_DIR, args.sessionId, 'exports')
  const filePath = join(exportsDir, fileName)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(payload, null, 2))

  return { filePath, elementCount: elements.length }
}
