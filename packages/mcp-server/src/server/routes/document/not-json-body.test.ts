// @vitest-environment node
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { apiErrorBodySchema, apiErrorReason } from '@kamiazya/whiteboard-server-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestDocument,
  resolveTestServerDeps,
  testDocumentRouterOptions,
  withTempDataDir,
} from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-not-json-body-test-')

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { clearDocCacheForTests } = await import('../../store/doc-cache.js')
const { createDocumentRouter } = await import('../document.js')

let serverDeps: ServerDeps
beforeEach(async () => {
  clearDocCacheForTests()
  serverDeps = await resolveTestServerDeps(tmp.dir)
  await createTestDocument(serverDeps, { workspaceId: 'ws1', path: 'real', kind: 'markdown' })
})

const NOT_JSON_REASON = 'the request body is not valid JSON'
const DOCUMENT = '/api/workspaces/ws1/documents/real'

const send = async (method: string, path: string, body: string) => {
  const app = createDocumentRouter(testDocumentRouterOptions({ serverDeps }))
  const res = await app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  return { status: res.status, json: (await res.json()) as unknown }
}

// A body that is not JSON is one mistake whichever route it is sent to, so
// every route of a voice answers it with the same body.
const PROBLEM_ROUTES: readonly [string, string, string][] = [
  ['create a workspace', 'POST', '/api/workspaces'],
  ['rename a workspace', 'PATCH', '/api/workspaces/ws1'],
  ['move a document', 'PUT', `${DOCUMENT}/path`],
]

const CODE_ROUTES: readonly [string, string, string][] = [
  ['name a workspace', 'PUT', '/api/workspaces/ws1/name'],
  ['name a document', 'PUT', `${DOCUMENT}/name`],
  ['pin a document', 'PUT', `${DOCUMENT}/pin`],
  ['save a version', 'POST', `${DOCUMENT}/versions`],
  ['restore a version', 'POST', `${DOCUMENT}/versions/v1/restore`],
  ['promote a workspace record', 'POST', '/api/w/ws1/workspace-document/promote'],
]

describe('a body that is not JSON, sent to a Problem Details route', () => {
  it.each(PROBLEM_ROUTES)('answers one title when asked to %s', async (_what, method, path) => {
    expect(await send(method, path, '{not json')).toEqual({
      status: 400,
      json: { title: NOT_JSON_REASON },
    })
  })
})

describe('a body that is not JSON, sent to an { error, message } route', () => {
  it.each(
    CODE_ROUTES,
  )('answers one code and message when asked to %s', async (_what, method, path) => {
    const answer = await send(method, path, '{not json')
    expect(answer).toEqual({
      status: 400,
      json: { error: 'invalid_body', message: NOT_JSON_REASON },
    })
    expect(apiErrorBodySchema.safeParse(answer.json).success).toBe(true)
    expect(apiErrorReason(answer.json)).toBe(NOT_JSON_REASON)
  })
})

// JSON that parses and does not fit is the route's own mistake to name, so
// each route answers in its own sentence, in the voice its clients read.
const WRONG_SHAPE: readonly [string, string, string, unknown, unknown][] = [
  ['create a workspace', 'POST', '/api/workspaces', {}, { title: 'displayName is required' }],
  [
    'rename a workspace',
    'PATCH',
    '/api/workspaces/ws1',
    { segment: 5 },
    { title: 'segment or displayName must be valid' },
  ],
  ['move a document', 'PUT', `${DOCUMENT}/path`, {}, { title: 'path is required' }],
  [
    'name a workspace',
    'PUT',
    '/api/workspaces/ws1/name',
    {},
    { error: 'invalid_body', message: 'name must be a string' },
  ],
  [
    'name a document',
    'PUT',
    `${DOCUMENT}/name`,
    {},
    { error: 'invalid_body', message: 'name must be a string' },
  ],
  [
    'pin a document',
    'PUT',
    `${DOCUMENT}/pin`,
    {},
    { error: 'invalid_body', message: 'pinned must be boolean' },
  ],
  [
    'restore a version',
    'POST',
    `${DOCUMENT}/versions/v1/restore`,
    { overwrite: 'yes' },
    { error: 'invalid_body', message: 'invalid restore options' },
  ],
]

describe('JSON of the wrong shape, sent to a route that reads a body', () => {
  it.each(
    WRONG_SHAPE,
  )("answers the route's own sentence when asked to %s", async (_what, method, path, body, expected) => {
    expect(await send(method, path, JSON.stringify(body))).toEqual({ status: 400, json: expected })
  })
})
