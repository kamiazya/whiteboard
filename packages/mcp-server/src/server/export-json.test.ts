import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { exportCanvasJsonDoc } from './export-json.js'

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

  it('writes to the provided absolute outputPath instead of the default exports dir', async () => {
    const outputPath = join(tempDir, 'custom-export.excalidraw')

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
    const outputPath = join(tempDir, 'nested', 'deep', 'out.excalidraw')

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
    const outputPath = join(tempDir, 'already-here.excalidraw')
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
    const outputPath = join(tempDir, 'will-be-replaced.excalidraw')
    await mkdir(tempDir, { recursive: true })
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
})
