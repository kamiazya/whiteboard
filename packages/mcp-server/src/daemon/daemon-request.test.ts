import { describe, expect, it } from 'vitest'
import { collectingDaemonSocket } from './_test-daemon-socket.js'
import { requestDaemon } from './daemon-request.js'

// The record's token is checked against the socket at the moment it is sent,
// not only when the record was read: a directory can vanish, or be replaced,
// between the two.
describe('requestDaemon', () => {
  it('sends no token to a socket in a directory others can enter', async () => {
    const socket = await collectingDaemonSocket(0o755, {})
    await expect(
      requestDaemon({
        record: { socketPath: socket.socketPath, token: 'tok' },
        method: 'GET',
        path: '/api/runtime/status',
      }),
    ).rejects.toThrow('may belong to another user')
    expect(socket.authorizations).toEqual([])
  })

  it('sends no token where the socket directory is reported missing', async () => {
    const socket = await collectingDaemonSocket(0o700, {})
    await expect(
      requestDaemon(
        {
          record: { socketPath: socket.socketPath, token: 'tok' },
          method: 'GET',
          path: '/api/runtime/status',
        },
        { socketTrust: () => ({ kind: 'absent' }) },
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(socket.authorizations).toEqual([])
  })

  it('sends the token to a socket in an owner-only directory of its own', async () => {
    const socket = await collectingDaemonSocket(0o700, {})
    const answer = await requestDaemon({
      record: { socketPath: socket.socketPath, token: 'tok' },
      method: 'GET',
      path: '/api/runtime/status',
    })
    expect(answer.status).toBe(200)
    expect(socket.authorizations).toEqual(['Bearer tok'])
  })

  // An ask without a credential has nothing to leak, and is how a named pipe
  // is asked to prove itself before anything is sent it.
  it('asks without a token whatever holds the socket', async () => {
    const socket = await collectingDaemonSocket(0o755, {})
    const answer = await requestDaemon({
      record: { socketPath: socket.socketPath },
      method: 'GET',
      path: '/api/runtime/ping',
    })
    expect(answer.status).toBe(200)
    expect(socket.authorizations).toEqual([undefined])
  })
})
