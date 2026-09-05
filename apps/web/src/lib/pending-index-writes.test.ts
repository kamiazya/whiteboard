/**
 * The one place a documented, measured data-loss regression is prevented:
 * a title typed and left immediately came back a character short, because
 * a QUEUED (not yet issued) write holds no IndexedDB transaction for
 * creation-order to protect a read against. These tests hold the module to
 * the three properties its doc comment claims, with hand-held deferreds —
 * no IndexedDB involved, the contract is purely about promise ordering.
 */
import { describe, expect, it } from 'vitest'
import { indexWritesSettled, trackIndexWrite } from './pending-index-writes.js'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('pending index writes', () => {
  it('a read started after a tracked write settles only after that write does', async () => {
    const write = deferred()
    trackIndexWrite(write.promise)

    let settled = false
    const read = indexWritesSettled().then(() => {
      settled = true
    })
    // Give the read every chance to resolve early — the assertion is that
    // it CANNOT while the write is open, not that it merely has not yet.
    await new Promise((r) => setTimeout(r, 0))
    expect(settled).toBe(false)

    write.resolve()
    await read
    expect(settled).toBe(true)
  })

  it('a rejected write still clears, and the rejection does not escape the tracker', async () => {
    const write = deferred()
    // Attach the caller's own handler the way a real save loop does, so the
    // tracked promise's rejection is observed exactly once.
    const observed = trackIndexWrite(write.promise).catch((err) => err)
    write.reject(new Error('quota'))
    expect(await observed).toBeInstanceOf(Error)
    // The failed write must not wedge every future read open.
    await expect(indexWritesSettled()).resolves.toBeUndefined()
  })

  it('a write registered WHILE settling is also waited for — the gap the loop exists to close', async () => {
    const first = deferred()
    const second = deferred()
    trackIndexWrite(first.promise)

    let settled = false
    const read = indexWritesSettled().then(() => {
      settled = true
    })

    // The save loop's shape: finishing the first write queues the next one
    // before anything else runs.
    void first.promise.then(() => {
      trackIndexWrite(second.promise)
    })
    first.resolve()
    await new Promise((r) => setTimeout(r, 0))
    expect(settled).toBe(false)

    second.resolve()
    await read
    expect(settled).toBe(true)
  })

  it('an empty set resolves without waiting on anything', async () => {
    await expect(indexWritesSettled()).resolves.toBeUndefined()
  })
})
