// @vitest-environment node
import { describe, expect, it } from 'vitest'

// The editor is a controlled view: persistence and sync are the host's job
// (`useDocumentSync` and the keeper). Its header is the one place a reader
// learns that, so the header must not claim the opposite.
async function headerOf(file: string): Promise<string> {
  const modules = import.meta.glob('./*.ts{,x}', { query: '?raw', import: 'default' })
  const entry = modules[file]
  expect(entry).toBeDefined()
  const source = (await entry?.()) as string
  const docComment = source.match(/^\/\*\*[\s\S]*?\*\//)?.[0]
  expect(docComment).toBeDefined()
  return docComment as string
}

describe('SpatialEditor header', () => {
  it('documents creation and deletion as supported', async () => {
    const supportedSection = (await headerOf('./SpatialEditor.tsx')).match(
      /Supported:[\s\S]*?(?=\n \*\n| \* The component)/,
    )?.[0]
    expect(supportedSection).toBeDefined()
    expect(supportedSection?.toLowerCase()).toContain('create')
    expect(supportedSection?.toLowerCase()).toContain('delete')
  })

  it('assigns persistence and sync to the host instead of listing them as unsupported', async () => {
    const header = await headerOf('./SpatialEditor.tsx')
    expect(header).not.toMatch(/NOT yet supported/i)
    expect(header).not.toContain('SPATIAL_EDITOR_UNSUPPORTED')
    expect(header).toMatch(/persistence and\s+sync[^.]*host/i)
  })
})
