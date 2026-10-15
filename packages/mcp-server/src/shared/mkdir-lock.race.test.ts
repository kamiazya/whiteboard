// Another waiter reclaims the dead lock and takes it, live, between this
// waiter's judgement and its break-lock mkdir. The interleaving is staged
// through a mocked `mkdir` that replays the other waiter's real steps.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const plan = vi.hoisted(() => ({ armed: false, otherHolds: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    mkdir: vi.fn(async (...args: Parameters<typeof actual.mkdir>) => {
      const path = String(args[0])
      if (plan.armed && path.endsWith('.break')) {
        plan.armed = false
        const lock = path.slice(0, -'.break'.length)
        await actual.rm(lock, { recursive: true, force: true })
        await actual.mkdir(lock)
        await actual.writeFile(
          join(lock, 'owner.json'),
          JSON.stringify({
            pid: process.pid,
            startedAt: new Date().toISOString(),
            host: hostname(),
          }),
        )
        plan.otherHolds = true
        setTimeout(() => {
          plan.otherHolds = false
          void actual.rm(lock, { recursive: true, force: true })
        }, 150)
      }
      return actual.mkdir(...args)
    }),
  }
})

const { withMkdirLock } = await import('./mkdir-lock.js')

const DEAD_PID = 2 ** 31 - 1
let dir: string

beforeEach(async () => {
  plan.armed = false
  plan.otherHolds = false
  dir = await mkdtemp(join(tmpdir(), 'mkdir-lock-race-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

it('leaves a lock another waiter re-acquired after this one judged it gone', async () => {
  const { mkdir } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const lock = join(dir, 'daemon.lock')
  await mkdir(lock)
  await writeFile(
    join(lock, 'owner.json'),
    JSON.stringify({ pid: DEAD_PID, startedAt: new Date().toISOString(), host: hostname() }),
  )
  plan.armed = true
  let overlapped: boolean | null = null
  await withMkdirLock(
    lock,
    async () => {
      overlapped = plan.otherHolds
    },
    { retryDelayMs: 10, timeoutMs: 3_000 },
  )
  expect(plan.armed).toBe(false)
  expect(overlapped).toBe(false)
})
