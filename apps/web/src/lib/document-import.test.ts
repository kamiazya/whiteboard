import { serializeSpatial } from '@kamiazya/whiteboard-codec'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { IMPORT_ACCEPT, importPathIn, readImportedFile } from './document-import.js'

describe('readImportedFile', () => {
  it('reads an OKF note with its title and type', async () => {
    const result = await readImportedFile(
      'trip.md',
      '---\ntype: plan\ntitle: Trip plan\n---\n# Hi\n',
    )
    expect(result).toMatchObject({
      ok: true,
      document: { kind: 'markdown', name: 'Trip plan', body: '# Hi\n', pathBase: 'trip' },
    })
    expect(
      result.ok && result.document.kind === 'markdown' && result.document.coreFacets.type,
    ).toBe('plan')
  })

  it('takes plain markdown with no frontmatter as the body of a note named after the file', async () => {
    const result = await readImportedFile('My Notes.markdown', '# Just text\n')
    expect(result).toMatchObject({
      ok: true,
      document: {
        kind: 'markdown',
        body: '# Just text\n',
        name: 'My Notes',
        pathBase: 'my-notes',
        coreFacets: { type: 'note' },
      },
    })
  })

  it('spells an accented file name into its address rather than dropping the letter', async () => {
    const result = await readImportedFile('Équipe Ops.md', '# Hi\n')
    expect(result).toMatchObject({
      ok: true,
      document: { name: 'Équipe Ops', pathBase: 'equipe-ops' },
    })
  })

  it('addresses a file whose name has no Latin spelling by its kind', async () => {
    expect(await readImportedFile('概要.md', '# Hi\n')).toMatchObject({
      ok: true,
      document: { name: '概要', pathBase: 'note' },
    })
    expect(await readImportedFile('図.canvas', '{"nodes":[],"edges":[]}')).toMatchObject({
      ok: true,
      document: { name: '図', pathBase: 'canvas' },
    })
  })

  it('reads a JSON Canvas file as a canvas', async () => {
    const text = serializeSpatial(
      { nodes: [textNode({ id: 'a', x: 0, y: 0, width: 10, height: 10, text: 'x' })], edges: [] },
      'extended',
    )
    const result = await readImportedFile('board.canvas', text)
    expect(result.ok && result.document.kind).toBe('spatial')
    expect(
      result.ok && result.document.kind === 'spatial' && result.document.canvas.nodes,
    ).toHaveLength(1)
  })

  it('reads a .json file that is JSON Canvas', async () => {
    expect((await readImportedFile('b.json', '{"nodes":[],"edges":[]}')).ok).toBe(true)
  })

  it('refuses a malformed canvas with its reason, never throwing', async () => {
    const result = await readImportedFile('b.canvas', '{nope')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/b\.canvas.*not valid JSON Canvas/i)
  })

  it('refuses frontmatter it cannot read with the file named', async () => {
    const result = await readImportedFile('a.md', '---\ntitle: [unclosed\n---\nbody')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toContain('a.md')
  })

  it('refuses a file of another type and says what is accepted', async () => {
    const result = await readImportedFile('photo.png', 'x')
    expect(!result.ok && result.reason).toMatch(/\.md.*\.canvas/)
  })
})

describe('the extensions a file may carry', () => {
  it('accepts exactly what the picker offers and refuses the rest', async () => {
    for (const ext of IMPORT_ACCEPT.split(',')) {
      const read = await readImportedFile(`x${ext}`, '{"nodes":[],"edges":[]}')
      expect(read.ok || ext.startsWith('.m')).toBe(true)
    }
    for (const name of ['x.png', 'README']) {
      const read = await readImportedFile(name, 'x')
      expect(read.ok).toBe(false)
    }
  })
})

describe('importPathIn', () => {
  it('places the file in the folder under its own name', async () => {
    expect(importPathIn('design', 'trip', ['other'])).toBe('design/trip')
    expect(importPathIn('', 'trip', [])).toBe('trip')
  })

  it('suffixes past a sibling that already holds the name', async () => {
    expect(importPathIn('d', 'trip', ['d/trip', 'd/trip-2'])).toBe('d/trip-3')
  })

  it('falls back to untitled for a name with nothing path-safe in it', async () => {
    expect(importPathIn('', '', [])).toBe('untitled')
  })
})
