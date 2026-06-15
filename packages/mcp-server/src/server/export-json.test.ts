import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { exportCanvasJsonDoc } from './export-json.js'
import { captureLogsForTests } from './log.js'

function buildDocWithRect(): LoroDoc {
  const doc = new LoroDoc()
  const list = doc.getMovableList('elements')
  const map = list.insertContainer(0, new LoroMap())
  map.set('id', 'rect-1')
  map.set('type', 'rectangle')
  map.set('x', 10)
  map.set('y', 20)
  map.set('width', 100)
  map.set('height', 50)
  doc.commit()
  return doc
}

describe('exportCanvasJsonDoc with outputPath', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-export-json-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('writes to the provided absolute outputPath inside the workspace exports dir', async () => {
    const outputPath = join(tempDir, 'sid', 'exports', 'custom-export.excalidraw')

    const result = await exportCanvasJsonDoc({
      workspaceId: 'sid',
      slug: 'canvas-a',
      doc: buildDocWithRect(),
      dataDir: tempDir,
      outputPath,
    })

    expect(result.filePath).toBe(outputPath)
    expect(result.elementCount).toBe(1)
    const written = JSON.parse(await readFile(outputPath, 'utf-8'))
    expect(written).toMatchObject({
      type: 'excalidraw',
      version: 2,
      elements: [expect.objectContaining({ id: 'rect-1' })],
    })
  })

  it('creates parent directories for outputPath when they do not exist', async () => {
    const outputPath = join(tempDir, 'sid', 'exports', 'nested', 'deep', 'out.excalidraw')

    const result = await exportCanvasJsonDoc({
      workspaceId: 'sid',
      slug: 'canvas-a',
      doc: buildDocWithRect(),
      dataDir: tempDir,
      outputPath,
    })

    expect(result.filePath).toBe(outputPath)
    await expect(readFile(outputPath, 'utf-8')).resolves.toMatch(/"type": "excalidraw"/)
  })

  it('rejects an outputPath outside the workspace exports dir even if inside dataDir', async () => {
    // ${dataDir}/daemon.json is inside dataDir but not inside ${dataDir}/sid/exports
    await expect(
      exportCanvasJsonDoc({
        workspaceId: 'sid',
        slug: 'canvas-a',
        doc: buildDocWithRect(),
        dataDir: tempDir,
        outputPath: join(tempDir, 'daemon.json'),
      }),
    ).rejects.toMatchObject({ name: 'OutputPathError', code: 'invalid_output_path' })
  })

  it('rejects an outputPath outside the workspace exports dir (different workspace path)', async () => {
    await expect(
      exportCanvasJsonDoc({
        workspaceId: 'sid',
        slug: 'canvas-a',
        doc: buildDocWithRect(),
        dataDir: tempDir,
        outputPath: join(tempDir, 'sid', '.checkpoints', 'v1.json'),
      }),
    ).rejects.toMatchObject({ name: 'OutputPathError', code: 'invalid_output_path' })
  })

  it('rejects a relative outputPath with a typed OutputPathError', async () => {
    await expect(
      exportCanvasJsonDoc({
        workspaceId: 'sid',
        slug: 'canvas-a',
        doc: buildDocWithRect(),
        dataDir: tempDir,
        outputPath: 'relative/out.excalidraw',
      }),
    ).rejects.toMatchObject({
      name: 'OutputPathError',
      code: 'invalid_output_path',
    })
  })

  it('refuses to overwrite an existing file by default and throws output_exists', async () => {
    const outputPath = join(tempDir, 'sid', 'exports', 'already-here.excalidraw')
    await mkdir(join(tempDir, 'sid', 'exports'), { recursive: true })
    await writeFile(outputPath, '{"type":"excalidraw","existing":true}')

    await expect(
      exportCanvasJsonDoc({
        workspaceId: 'sid',
        slug: 'canvas-a',
        doc: buildDocWithRect(),
        dataDir: tempDir,
        outputPath,
      }),
    ).rejects.toMatchObject({
      name: 'OutputPathError',
      code: 'output_exists',
    })

    // Original file untouched.
    await expect(readFile(outputPath, 'utf-8')).resolves.toContain('"existing":true')
  })

  it('replaces an existing file when overwrite=true', async () => {
    const outputPath = join(tempDir, 'sid', 'exports', 'will-be-replaced.excalidraw')
    await mkdir(join(tempDir, 'sid', 'exports'), { recursive: true })
    await writeFile(outputPath, 'OLD CONTENTS')

    const result = await exportCanvasJsonDoc({
      workspaceId: 'sid',
      slug: 'canvas-a',
      doc: buildDocWithRect(),
      dataDir: tempDir,
      outputPath,
      overwrite: true,
    })

    expect(result.filePath).toBe(outputPath)
    const written = JSON.parse(await readFile(outputPath, 'utf-8'))
    expect(written.elements).toHaveLength(1)
  })

  it('still falls back to the default exports dir when outputPath is omitted', async () => {
    const result = await exportCanvasJsonDoc({
      workspaceId: 'sid-fallback',
      slug: 'canvas-a',
      doc: buildDocWithRect(),
      dataDir: tempDir,
    })

    expect(result.filePath).toContain(join(tempDir, 'sid-fallback', 'exports'))
    expect(result.filePath.endsWith('.excalidraw')).toBe(true)
  })

  it('drops corrupt elements, logs exactly one warning per bad row, and exports only valid elements', async () => {
    // Build a doc with one valid rect + one corrupt row (missing id).
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const validMap = list.insertContainer(0, new LoroMap())
    validMap.set('id', 'rect-valid')
    validMap.set('type', 'rectangle')
    validMap.set('x', 10)
    validMap.set('y', 20)
    validMap.set('width', 100)
    validMap.set('height', 50)
    // Corrupt row: missing 'id' field
    const corruptMap = list.insertContainer(1, new LoroMap())
    corruptMap.set('x', 5)
    corruptMap.set('y', 5)
    corruptMap.set('width', 30)
    corruptMap.set('height', 30)
    doc.commit()

    const outputPath = join(tempDir, 'sid', 'exports', 'corrupt-test.excalidraw')
    const capture = captureLogsForTests('warning')
    let result: { filePath: string; elementCount: number }
    try {
      result = await exportCanvasJsonDoc({
        workspaceId: 'sid',
        slug: 'canvas-corrupt',
        doc,
        dataDir: tempDir,
        outputPath,
      })
    } finally {
      capture.restore()
    }

    // Only the valid element should be exported.
    expect(result!.elementCount).toBe(1)

    // The exported file should be valid excalidraw JSON with no NaN coords.
    const written = JSON.parse(await readFile(outputPath, 'utf-8'))
    expect(written.type).toBe('excalidraw')
    expect(written.elements).toHaveLength(1)
    expect(written.elements[0].id).toBe('rect-valid')
    const el = written.elements[0]
    expect(Number.isNaN(el.x)).toBe(false)
    expect(Number.isNaN(el.y)).toBe(false)

    // Exactly one warning record for the dropped corrupt row.
    const warnings = capture.records.filter((r) => r.level === 'warning' && r.scope === 'export-json')
    expect(warnings).toHaveLength(1)
  })
})
