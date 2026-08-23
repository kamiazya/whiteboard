// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { fakeFilesSource } from './fake-files-source.js'

// The default `searchDocuments` used to answer `[]` for every query, which
// reads as "quietest possible answer" and is really a source contradicting
// its own listing: it says nothing matches while the documents it just
// listed plainly do.
//
// That is not a harmless lie. WorkspaceFilesPanel shows a client-side match
// over the loaded list only WHILE the source's answer is in flight, then
// switches to what the source said — so a test that types a query saw its
// results for ~150ms and then watched them vanish. Whether it passed came
// down to whether its queries beat the debounce, which on a loaded machine
// they do not. One test flaked on exactly this.
describe('the fake source, asked to search', () => {
  const entries = [
    { documentId: 'd1', path: 'meeting-notes', name: 'Meeting notes', kind: 'markdown' as const },
    { documentId: 'd2', path: 'plans/roadmap', name: 'Roadmap', kind: 'spatial' as const },
  ]

  it('answers from the documents it lists, so it cannot contradict itself', async () => {
    const source = fakeFilesSource({ listDocuments: async () => entries })
    const hits = await source.searchDocuments('road', 20)
    expect(hits.map((hit) => hit.document.path)).toEqual(['plans/roadmap'])
  })

  it('answers nothing when nothing in the listing matches', async () => {
    const source = fakeFilesSource({ listDocuments: async () => entries })
    expect(await source.searchDocuments('zarquon', 20)).toEqual([])
  })

  it('still lets a test say exactly what the source found', async () => {
    const hit = { document: entries[0] as (typeof entries)[number], contexts: ['a body match'] }
    const source = fakeFilesSource({
      listDocuments: async () => entries,
      searchDocuments: async () => [hit],
    })
    expect(await source.searchDocuments('anything', 20)).toEqual([hit])
  })

  it('honours the limit', async () => {
    const source = fakeFilesSource({ listDocuments: async () => entries })
    expect((await source.searchDocuments('', 1)).length).toBeLessThanOrEqual(1)
  })
})
