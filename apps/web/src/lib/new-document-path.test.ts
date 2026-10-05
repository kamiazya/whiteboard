// @vitest-environment node
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  MARKDOWN_BODY_KEY,
  readWorkspaceDocuments,
  seedNameFromTitle,
} from '@kamiazya/whiteboard-loro-adapter'
import { documentPathSchema, generateDocumentId } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { newDocumentPathIn } from './new-document-path.js'

describe('newDocumentPathIn', () => {
  it('creates in the folder the browser is standing in', () => {
    expect(newDocumentPathIn('design/notes', [])).toBe('design/notes/untitled')
  })

  it('creates at the top level when that is where you are', () => {
    expect(newDocumentPathIn('', [])).toBe('untitled')
  })

  // Numbering is per folder: `design/untitled` does not make the next
  // document at the root `untitled-2`, because they do not collide.
  it('numbers within the folder, not across the workspace', () => {
    const taken = ['untitled', 'design/untitled', 'design/untitled-2']
    expect(newDocumentPathIn('design', taken)).toBe('design/untitled-3')
    expect(newDocumentPathIn('inbox', taken)).toBe('inbox/untitled')
  })

  it('skips the numbers already taken here', () => {
    expect(newDocumentPathIn('', ['untitled', 'untitled-2', 'untitled-4'])).toBe('untitled-3')
  })

  // A folder deeper down is not a sibling: `design/notes/untitled` must not
  // make `design/untitled` look taken.
  it('ignores what lives further down', () => {
    expect(newDocumentPathIn('design', ['design/notes/untitled'])).toBe('design/untitled')
  })

  // The prefix is anchored at a segment boundary, the same rule the contents
  // pane uses. The fixture is chosen so an unanchored slice would produce
  // exactly `untitled`: 'design-untitled' cut at the length of 'design/'
  // leaves 'untitled', and a near-miss like 'design-system/untitled' would
  // leave 'system/untitled' and pass whether the rule is there or not.
  it('anchors the folder at a segment boundary', () => {
    expect(newDocumentPathIn('design', ['design-untitled'])).toBe('design/untitled')
    expect(newDocumentPathIn('design', ['design-system/untitled'])).toBe('design/untitled')
  })

  // Paths drawn near the generator's own output, so a collision is the
  // usual case rather than a lucky one.
  const nearUntitled = fc.oneof(
    fc.constant('untitled'),
    fc.integer({ min: 1, max: 12 }).map((n) => `untitled-${n}`),
    fc.string(),
  )

  fcTest.prop([fc.array(nearUntitled)], withDefaults())(
    'never answers a path already taken, and always one the path grammar accepts',
    (existing) => {
      const path = newDocumentPathIn('', existing)
      expect(existing).not.toContain(path)
      expect(documentPathSchema.safeParse(path).success).toBe(true)
    },
  )
})

describe('a generated path against the naming gate', () => {
  // Every keeper names a note after its heading only while its path is one
  // this generator chose (loro-adapter's `isGeneratedDocumentPath`). The two
  // have to agree, or a note made here keeps the name `untitled` however
  // plainly its first line says what it is.
  fcTest.prop([fc.integer({ min: 1, max: 12 })], withDefaults())(
    'a heading names every note the generator placed',
    (howMany) => {
      const workspace = new LoroDoc()
      const taken: string[] = []
      for (let i = 0; i < howMany; i++) {
        const path = newDocumentPathIn('design', taken)
        taken.push(path)
        const documentId = generateDocumentId()
        createWorkspaceDocumentAtPath(workspace, { path, documentId, kind: 'markdown' })
        documentContainers(workspace, documentId).getText(MARKDOWN_BODY_KEY).insert(0, `# N${i}`)
        workspace.commit()
        seedNameFromTitle(workspace, documentId)
      }
      const notes = readWorkspaceDocuments(workspace)
      expect(notes).toHaveLength(howMany)
      for (const note of notes) expect(note.name, note.path).toMatch(/^N\d+$/)
    },
  )
})
