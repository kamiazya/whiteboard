// @vitest-environment node
import { installSearchCore, type SearchCore } from '@kamiazya/whiteboard-search'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { searchDocuments } from './search-documents.js'

// This list filters as someone types and must draw whatever the search core
// does: with none installed (the wasm did not load) or one that declines an
// input past a cap, it compares plain lower-cased text rather than failing.

const docs: WorkspaceDocumentEntry[] = [
  { documentId: 'd1', path: 'design/Login', name: 'Login flow' },
  { documentId: 'd2', path: 'inbox/triage', name: 'Triage' },
]

let realm: SearchCore | undefined
afterEach(() => {
  installSearchCore(realm)
})

const refusal = () => {
  const err = new Error('past the cap')
  err.name = 'CoreInputRefused'
  return err
}

describe('searchDocuments without a usable search core', () => {
  it('compares lower-cased text when no core is installed', () => {
    realm = installSearchCore(undefined)
    expect(searchDocuments(docs, 'LOGIN').map((d) => d.path)).toEqual(['design/Login'])
    expect(searchDocuments(docs, 'flow').map((d) => d.path)).toEqual(['design/Login'])
  })

  it('compares lower-cased text when the core declines the input', () => {
    realm = installSearchCore(undefined)
    if (realm === undefined) throw new Error('the test realm installs a search core')
    installSearchCore({
      ...realm,
      foldForSearch: () => {
        throw refusal()
      },
      folderNamesOf: () => {
        throw refusal()
      },
    })
    expect(searchDocuments(docs, 'triage').map((d) => d.path)).toEqual(['inbox/triage'])
  })

  it.each([
    'CoreInstanceTrapped',
    'CoreUnrecoverable',
    'CoreHandleLost',
  ])('compares lower-cased text for the call whose core raised %s', (name) => {
    realm = installSearchCore(undefined)
    if (realm === undefined) throw new Error('the test realm installs a search core')
    installSearchCore({
      ...realm,
      foldForSearch: () => {
        throw Object.assign(new Error('the instance was reset'), { name })
      },
      folderNamesOf: () => {
        throw Object.assign(new Error('the instance was reset'), { name })
      },
    })
    expect(searchDocuments(docs, 'triage').map((d) => d.path)).toEqual(['inbox/triage'])
  })

  it('compares the query and the names in one form when only a lone fold traps', () => {
    realm = installSearchCore(undefined)
    if (realm === undefined) throw new Error('the test realm installs a search core')
    const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    installSearchCore({
      ...realm,
      // A call holding several texts answers; a call holding one traps.
      foldForSearch: (text: string) => {
        if (!text.includes('\n')) {
          throw Object.assign(new Error('the instance was reset'), { name: 'CoreInstanceTrapped' })
        }
        return fold(text)
      },
    })
    const cafe: WorkspaceDocumentEntry[] = [
      { documentId: 'c1', path: 'notes/café', name: 'Café' },
      ...docs,
    ]
    expect(searchDocuments(cafe, 'café').map((d) => d.path)).toEqual(['notes/café'])
  })

  it('does not hide a failure that is neither', () => {
    realm = installSearchCore(undefined)
    if (realm === undefined) throw new Error('the test realm installs a search core')
    installSearchCore({
      ...realm,
      foldForSearch: () => {
        throw new Error('a defect')
      },
    })
    expect(() => searchDocuments(docs, 'login')).toThrowError('a defect')
  })

  it('answers through the core when one is installed', () => {
    realm = installSearchCore(undefined)
    if (realm === undefined) throw new Error('the test realm installs a search core')
    // A spelling only the core's folding knows: plain lower-casing would not find it.
    installSearchCore({
      ...realm,
      foldForSearch: (text) => text.toLowerCase().replaceAll('triage', 'zzz'),
    })
    expect(searchDocuments(docs, 'zzz').map((d) => d.path)).toEqual(['inbox/triage'])
  })
})
