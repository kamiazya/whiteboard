/**
 * What the editor is allowed to upload is declared once, in daemon-client's
 * `api-contracts/files`, and the daemon's file route has to answer that set
 * with 204 through the real app. The route used to carry a list of its own,
 * so the two could — and did — disagree without either side's tests noticing.
 */
import {
  MAX_FILE_UPLOAD_BYTES,
  UPLOADABLE_IMAGE_TYPES,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/files'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { storeMemoryModule } from '../../shared/test-utils/store-memory.module.js'
import { testDataLayout, withTempDataDir } from './_test-helpers.js'

const tmp = withTempDataDir('whiteboard-files-uploadable-')

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createApp } = await import('../app.js')
const { createContainer, resolveServerDeps } = await import('../../di/container.js')

const TOKEN = 'uploadable-token'

function app() {
  return createApp({
    authMode: 'local-daemon' as const,
    token: TOKEN,
    serverDeps: resolveServerDeps(createContainer(storeMemoryModule)),
    dataLayout: testDataLayout(tmp.dir),
    touch: vi.fn(),
    getStatus: vi.fn(),
  } as unknown as Parameters<typeof createApp>[0])
}

function put(
  target: ReturnType<typeof app>,
  fileId: string,
  type: string,
  body: Uint8Array<ArrayBuffer>,
) {
  return target.request(`/api/w/ws-up/document/board/file/${fileId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': type },
    body,
  })
}

describe('the daemon file route against the declared upload contract', () => {
  let target: ReturnType<typeof app>
  beforeEach(() => {
    target = app()
  })

  it('declares a population, so the per-type cases below are not vacuous', () => {
    expect(UPLOADABLE_IMAGE_TYPES.length).toBeGreaterThanOrEqual(5)
  })

  it.each(
    UPLOADABLE_IMAGE_TYPES,
  )('stores %s and reads it back under the same type', async (type) => {
    const id = `up-${type.replace(/\W/g, '')}`
    const stored = await put(target, id, type, new Uint8Array([1, 2, 3]))
    expect(stored.status).toBe(204)
    const read = await target.request(`/api/w/ws-up/document/board/file/${id}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    expect(read.status).toBe(200)
    expect(read.headers.get('Content-Type')).toBe(type)
  })

  it('refuses a type outside the contract with 415 naming every supported one', async () => {
    const res = await put(target, 'avif1', 'image/avif', new Uint8Array([1]))
    expect(res.status).toBe(415)
    const body = (await res.json()) as { message: string }
    for (const type of UPLOADABLE_IMAGE_TYPES) expect(body.message).toContain(type)
  })

  it('accepts exactly the contract ceiling and refuses one byte more with 413', async () => {
    const atLimit = await put(target, 'big1', 'image/png', new Uint8Array(MAX_FILE_UPLOAD_BYTES))
    expect(atLimit.status).toBe(204)
    const over = await put(target, 'big2', 'image/png', new Uint8Array(MAX_FILE_UPLOAD_BYTES + 1))
    expect(over.status).toBe(413)
  })
})
