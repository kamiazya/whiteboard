import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import * as urls from './daemon-urls.js'
import { workspaceDocumentApiUrl } from './document-url.js'
import { signInRefusalSchema } from './sign-in.js'

// The literal strings the clients built by hand before the builders existed:
// moving a call onto a builder must not change a byte on the wire.
const WS = 'ws a'
const PATH = 'notes/a b/é'
const ENC_WS = 'ws%20a'
const ENC_PATH = 'notes/a%20b/%C3%A9'

describe('daemon URL builders keep the bytes clients sent before', () => {
  it.each([
    ['workspacesApiUrl', urls.workspacesApiUrl(), '/api/workspaces'],
    ['workspaceApiUrl', urls.workspaceApiUrl(WS), `/api/workspaces/${ENC_WS}`],
    ['workspaceNamesApiUrl', urls.workspaceNamesApiUrl(WS), `/api/workspaces/${ENC_WS}/names`],
    [
      'workspaceDocumentsApiUrl',
      urls.workspaceDocumentsApiUrl(WS),
      `/api/workspaces/${ENC_WS}/documents`,
    ],
    [
      'documentRecordApiUrl',
      urls.documentRecordApiUrl(WS, PATH),
      `/api/workspaces/${ENC_WS}/documents/${ENC_PATH}`,
    ],
    [
      'documentPathApiUrl',
      urls.documentPathApiUrl(WS, PATH),
      `/api/workspaces/${ENC_WS}/documents/${ENC_PATH}/path`,
    ],
    [
      'documentNameApiUrl',
      urls.documentNameApiUrl(WS, PATH),
      `/api/workspaces/${ENC_WS}/documents/${ENC_PATH}/name`,
    ],
    [
      'documentPinApiUrl',
      urls.documentPinApiUrl(WS, PATH),
      `/api/workspaces/${ENC_WS}/documents/${ENC_PATH}/pin`,
    ],
    [
      'documentVersionsApiUrl',
      urls.documentVersionsApiUrl(WS, PATH),
      `/api/workspaces/${ENC_WS}/documents/${ENC_PATH}/versions`,
    ],
    [
      'versionDocumentApiUrl',
      urls.versionDocumentApiUrl(WS, PATH, 'v/1'),
      `/api/workspaces/${ENC_WS}/documents/${ENC_PATH}/versions/v%2F1/document`,
    ],
    [
      'versionRestoreApiUrl',
      urls.versionRestoreApiUrl(WS, PATH, 'v/1'),
      `/api/workspaces/${ENC_WS}/documents/${ENC_PATH}/versions/v%2F1/restore`,
    ],
    ['trashApiUrl', urls.trashApiUrl(WS), `/api/workspaces/${ENC_WS}/trash`],
    ['trashEntryApiUrl', urls.trashEntryApiUrl(WS, 'd/1'), `/api/workspaces/${ENC_WS}/trash/d%2F1`],
    [
      'trashRestoreApiUrl',
      urls.trashRestoreApiUrl(WS, 'd/1'),
      `/api/workspaces/${ENC_WS}/trash/d%2F1/restore`,
    ],
    [
      'optimizeAllApiUrl',
      urls.optimizeAllApiUrl(WS),
      `/api/workspaces/${ENC_WS}/documents/optimize-all`,
    ],
    [
      'pruneSandwichedApiUrl',
      urls.pruneSandwichedApiUrl(WS),
      `/api/workspaces/${ENC_WS}/versions/prune-sandwiched`,
    ],
    [
      'purgeDanglingApiUrl',
      urls.purgeDanglingApiUrl(WS),
      `/api/workspaces/${ENC_WS}/files/purge-dangling`,
    ],
    ['storageReportApiUrl', urls.storageReportApiUrl(), '/api/runtime/storage'],
    ['runtimePingApiUrl', urls.runtimePingApiUrl(), '/api/runtime/ping'],
    ['syncStreamApiUrl', urls.syncStreamApiUrl(), '/api/sync/stream'],
    ['syncSubscribeApiUrl', urls.syncSubscribeApiUrl(), '/api/sync/subscribe'],
    ['syncMessageApiUrl', urls.syncMessageApiUrl(), '/api/sync/message'],
    ['runtimeStatusApiUrl', urls.runtimeStatusApiUrl(), '/api/runtime/status'],
    [
      'replicaKeyRotateApiUrl',
      urls.replicaKeyRotateApiUrl(WS),
      `/api/workspaces/${ENC_WS}/replica-key/rotate`,
    ],
    ['replicaTierApiUrl', urls.replicaTierApiUrl(WS), `/api/workspaces/${ENC_WS}/replica-tier`],
    ['documentsV1ApiUrl', urls.documentsV1ApiUrl(WS), `/api/v1/workspaces/${ENC_WS}/documents`],
    [
      'documentBacklinksApiUrl',
      urls.documentBacklinksApiUrl(WS, 'd/1'),
      `/api/v1/workspaces/${ENC_WS}/documents/d%2F1/backlinks`,
    ],
    [
      'linkifyMentionsApiUrl',
      urls.linkifyMentionsApiUrl(WS, 'd/1'),
      `/api/v1/workspaces/${ENC_WS}/documents/d%2F1/linkify-mentions`,
    ],
    [
      'documentOkfApiUrl',
      urls.documentOkfApiUrl(WS, 'd/1'),
      `/api/v1/workspaces/${ENC_WS}/documents/d%2F1/okf`,
    ],
    [
      'documentTagsApiUrl',
      urls.documentTagsApiUrl(WS),
      `/api/v1/workspaces/${ENC_WS}/document-tags`,
    ],
    [
      'searchApiUrl',
      urls.searchApiUrl(WS, { query: 'plan x', limit: 10 }),
      `/api/v1/workspaces/${ENC_WS}/search?q=plan+x&limit=10`,
    ],
    ['fontsApiUrl', urls.fontsApiUrl(), '/api/fonts'],
    ['fontInstallApiUrl', urls.fontInstallApiUrl('f/1'), '/api/fonts/f%2F1/install'],
    ['fontFileApiUrl', urls.fontFileApiUrl('f/1'), '/api/fonts/f%2F1/file'],
    [
      'workspaceDocumentApiUrl',
      workspaceDocumentApiUrl(WS, 'promote'),
      `/api/w/${ENC_WS}/workspace-document/promote`,
    ],
  ])('%s', (_name, built, before) => {
    expect(built).toBe(before)
  })
})

// The server-mode sign-in family is written by one process and read by
// another, so each writer is checked against its own reader rather than
// against a spelling of the keys.
const optional = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined })
const anyText = fc.string({ unit: 'binary', maxLength: 24 })

describe('server-mode sign-in URLs read back through their own readers', () => {
  fcTest.prop([anyText, optional(anyText), optional(anyText)], withDefaults())(
    'authSignInUrl carries returnTo and invitation to signInQueryOf',
    (providerId, returnTo, invitation) => {
      const built = new URL(
        urls.authSignInUrl(providerId, {
          ...(returnTo === undefined ? {} : { returnTo }),
          ...(invitation === undefined ? {} : { invitation }),
        }),
        'https://keeper.test',
      )
      expect(built.pathname).toBe(
        new URL(urls.authSignInUrl(providerId), 'https://k.test').pathname,
      )
      const read = urls.signInQueryOf((name) => built.searchParams.get(name) ?? undefined)
      expect(read).toEqual({
        ...(returnTo === undefined ? {} : { returnTo }),
        ...(invitation === undefined ? {} : { invitation }),
      })
    },
  )

  fcTest.prop([optional(anyText)], withDefaults())(
    'authReauthenticateUrl carries returnTo to signInQueryOf',
    (returnTo) => {
      const built = new URL(
        urls.authReauthenticateUrl(returnTo === undefined ? {} : { returnTo }),
        'https://keeper.test',
      )
      const read = urls.signInQueryOf((name) => built.searchParams.get(name) ?? undefined)
      expect(read).toEqual(returnTo === undefined ? {} : { returnTo })
    },
  )

  fcTest.prop([anyText], withDefaults())(
    'invitePageUrl opens the invite page with a token inviteTokenOf reads',
    (token) => {
      const built = new URL(urls.invitePageUrl('https://keeper.test', token))
      expect(built.pathname).toBe(urls.INVITE_PAGE_PATH)
      expect(built.search).toBe('')
      expect(urls.inviteTokenOf(built.hash)).toBe(token)
    },
  )

  it.each(
    signInRefusalSchema.options,
  )('signInPageUrl(%s) is read back by signInRefusalOf', (reason) => {
    const built = new URL(urls.signInPageUrl(reason), 'https://keeper.test')
    expect(built.pathname).toBe(urls.SIGN_IN_PAGE_PATH)
    expect(urls.signInRefusalOf(built.search)).toBe(reason)
  })

  it('reads no refusal from a sign-in page opened without one', () => {
    expect(urls.signInPageUrl()).toBe(urls.SIGN_IN_PAGE_PATH)
    expect(urls.signInRefusalOf('')).toBeUndefined()
  })

  it('reads no invitation from an invite page opened without a token', () => {
    expect(urls.inviteTokenOf('')).toBeUndefined()
    expect(urls.inviteTokenOf('#')).toBeUndefined()
  })

  // The bytes the web app and the keeper sent before the codecs existed.
  it.each([
    [
      urls.authSignInUrl('corp', { returnTo: '/', invitation: 'inv-123' }),
      '/auth/sign-in/corp?return=%2F&invitation=inv-123',
    ],
    [urls.authSignInUrl('corp'), '/auth/sign-in/corp'],
    [urls.authReauthenticateUrl({ returnTo: '/people' }), '/auth/reauthenticate?return=%2Fpeople'],
    [urls.invitePageUrl('https://keeper.test', 'inv-1'), 'https://keeper.test/invite#token=inv-1'],
    [urls.signInPageUrl('not_invited'), '/sign-in?error=not_invited'],
  ])('%s keeps its bytes', (built, before) => {
    expect(built).toBe(before)
  })
})
