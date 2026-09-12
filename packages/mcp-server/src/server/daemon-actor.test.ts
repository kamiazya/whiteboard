import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createDaemonIdentity } from './security/daemon-identity.js'

const { DAEMON_AGENT_ACTOR, daemonDeviceActor } = await import('./daemon-actor.js')

const dirs: string[] = []
async function freshDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-daemon-actor-'))
  dirs.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('how this daemon names itself', () => {
  // The two answers must not be swapped: a stored row given the process
  // actor claims a different agent after every restart, and the live socket
  // given the device DID cannot tell two daemons on one data dir apart.
  it('answers the live socket with a process actor and a stored row with a device DID', async () => {
    const dataDir = await freshDataDir()

    expect(DAEMON_AGENT_ACTOR).toMatch(/^process:daemon-/)
    expect(daemonDeviceActor(dataDir)).toMatch(/^did:key:z6Mk/)
  })

  // One file, one answer: the row an agent save stamps has to be the key
  // `/api/runtime/ping` advertises, or a reader cannot connect the two.
  it('answers with the very key the daemon identity holds', async () => {
    const dataDir = await freshDataDir()

    expect(daemonDeviceActor(dataDir)).toBe(createDaemonIdentity({ dataDir }).did)
  })

  // The memo is keyed, not a single slot. A slot would serve the first data
  // dir's DID to every later one — and the fallback ServerDeps builds per
  // request, so a test or a second workspace would be told the wrong device.
  it('memoizes per data dir rather than serving the first one to everybody', async () => {
    const first = await freshDataDir()
    const second = await freshDataDir()

    expect(daemonDeviceActor(first)).toBe(daemonDeviceActor(first))
    expect(daemonDeviceActor(second)).not.toBe(daemonDeviceActor(first))
  })
})
