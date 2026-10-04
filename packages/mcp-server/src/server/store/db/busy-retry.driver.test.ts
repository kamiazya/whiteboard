import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { busyRetryingDialect } from './busy-retry.js'

// The driver underneath is faked so a refusal can be produced on demand: a
// real busy database needs a second process holding the write lock, and the
// branches pinned here (inside a transaction, after one, the default budget)
// would each need one. `randomInt` answers the top of its range so the pauses,
// and therefore the default budget's arithmetic, are exact.
const fake = vi.hoisted(() => {
  const conn = { executeQuery: vi.fn(), streamQuery: vi.fn() }
  return {
    draws: [] as [number, number][],
    client: { reconnect: vi.fn(async () => {}), close: vi.fn() },
    conn,
    driver: {
      init: vi.fn(async () => {}),
      acquireConnection: vi.fn(async () => conn),
      beginTransaction: vi.fn(async () => {}),
      commitTransaction: vi.fn(async () => {}),
      rollbackTransaction: vi.fn(async () => {}),
      releaseConnection: vi.fn(async () => {}),
      destroy: vi.fn(async () => {}),
    },
  }
})
vi.mock('node:crypto', async (original) => ({
  ...(await original<typeof import('node:crypto')>()),
  randomInt: (min: number, max: number) => {
    fake.draws.push([min, max])
    return max - 1
  },
}))
vi.mock('@libsql/client', () => ({ createClient: () => fake.client }))
vi.mock('@libsql/kysely-libsql', () => ({
  LibsqlDialect: class {
    createDriver() {
      return fake.driver
    }
  },
}))

const { client, conn, driver } = fake
const busy = () => Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
const query = { sql: 'insert', parameters: [], query: {} as never, queryId: {} as never }
const QUICK = { ceilingMs: 500, baseDelayMs: 1, maxDelayMs: 2 }

beforeEach(() => {
  vi.clearAllMocks()
  conn.executeQuery.mockReset()
  driver.beginTransaction.mockReset()
  driver.commitTransaction.mockReset()
  fake.draws.length = 0
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

async function connect(policy?: Parameters<typeof busyRetryingDialect>[1]) {
  const d = busyRetryingDialect({ url: 'file:unused' }, policy).createDriver()
  return { d, c: await d.acquireConnection() }
}

/** Settle `promise` while the fake clock runs every pause it schedules. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  const outcome = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  )
  await vi.runAllTimersAsync()
  const result = await outcome
  if ('error' in result) throw result.error
  return result.value
}

describe('a statement inside a transaction', () => {
  it('is not retried and leaves the connection the transaction owns in place', async () => {
    const { d, c } = await connect(QUICK)
    await d.beginTransaction(c, {})
    conn.executeQuery.mockRejectedValue(busy())
    await expect(c.executeQuery(query)).rejects.toMatchObject({ code: 'SQLITE_BUSY' })
    expect(conn.executeQuery).toHaveBeenCalledTimes(1)
    expect(client.reconnect).not.toHaveBeenCalled()
  })

  it.each([
    ['committed', 'commitTransaction'],
    ['rolled back', 'rollbackTransaction'],
  ] as const)('is retried again once the transaction %s', async (_how, finish) => {
    const { d, c } = await connect(QUICK)
    await d.beginTransaction(c, {})
    await d[finish](c)
    conn.executeQuery.mockRejectedValueOnce(busy()).mockResolvedValueOnce({ rows: [] })
    await expect(settle(c.executeQuery(query))).resolves.toEqual({ rows: [] })
    expect(conn.executeQuery).toHaveBeenCalledTimes(2)
  })

  it('is retried again even when the commit that ended the transaction failed', async () => {
    const { d, c } = await connect(QUICK)
    await d.beginTransaction(c, {})
    driver.commitTransaction.mockRejectedValueOnce(new Error('cannot commit'))
    await expect(d.commitTransaction(c)).rejects.toThrow('cannot commit')
    conn.executeQuery.mockRejectedValueOnce(busy()).mockResolvedValueOnce({ rows: [] })
    await settle(c.executeQuery(query))
    expect(conn.executeQuery).toHaveBeenCalledTimes(2)
  })
})

describe('the retrying driver', () => {
  it('retries the transaction start, replacing the connection after each refusal', async () => {
    const { d, c } = await connect(QUICK)
    driver.beginTransaction.mockRejectedValueOnce(busy()).mockResolvedValueOnce(undefined)
    await settle(d.beginTransaction(c, {}))
    expect(driver.beginTransaction).toHaveBeenCalledTimes(2)
    expect(driver.beginTransaction).toHaveBeenLastCalledWith(conn, {})
    expect(client.reconnect).toHaveBeenCalledTimes(1)
  })

  it('closes the client it made when it is destroyed', async () => {
    const { d } = await connect(QUICK)
    await d.destroy()
    expect(driver.destroy).toHaveBeenCalledTimes(1)
    expect(client.close).toHaveBeenCalledTimes(1)
  })

  it('hands the inner connection back on release', async () => {
    const { d, c } = await connect(QUICK)
    await d.releaseConnection(c)
    expect(driver.releaseConnection).toHaveBeenCalledWith(conn)
  })

  it('passes a stream through to the inner connection', async () => {
    const { c } = await connect(QUICK)
    c.streamQuery(query, 7)
    expect(conn.streamQuery).toHaveBeenCalledWith(query, 7)
  })

  it('reads an extended busy code as busy too', async () => {
    const { c } = await connect(QUICK)
    conn.executeQuery
      .mockRejectedValueOnce(
        Object.assign(new Error('x'), { extendedCode: 'SQLITE_BUSY_SNAPSHOT' }),
      )
      .mockResolvedValueOnce({ rows: [] })
    await expect(settle(c.executeQuery(query))).resolves.toEqual({ rows: [] })
  })
})

describe('the default budget', () => {
  // Pauses at the top of their range: 5, 10, 20, 40, 80, then 100 each, so the
  // 24th refusal is the first whose pause would carry the wait past 2s.
  it('gives up after 1955ms and 24 attempts with a typed error carrying the last refusal', async () => {
    const cause = busy()
    conn.executeQuery.mockRejectedValue(cause)
    const { c } = await connect()
    const error = await settle(c.executeQuery(query)).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({
      name: 'DatabaseBusyError',
      code: 'SQLITE_BUSY',
      waitedMs: 1_955,
      attempts: 24,
      cause,
      message: 'database stayed locked by another process for 1955ms across 24 attempts',
    })
    expect(conn.executeQuery).toHaveBeenCalledTimes(24)
    expect(client.reconnect).toHaveBeenCalledTimes(24)
  })

  it('counts attempts from one: a policy with no room reports a single attempt', async () => {
    conn.executeQuery.mockRejectedValue(busy())
    const { c } = await connect({ ceilingMs: 0, baseDelayMs: 5, maxDelayMs: 5 })
    await expect(c.executeQuery(query)).rejects.toMatchObject({ attempts: 1, waitedMs: 0 })
    expect(conn.executeQuery).toHaveBeenCalledTimes(1)
  })

  it('still takes a pause that ends exactly at the ceiling', async () => {
    conn.executeQuery.mockRejectedValueOnce(busy()).mockResolvedValueOnce({ rows: [] })
    const { c } = await connect({ ceilingMs: 5, baseDelayMs: 5, maxDelayMs: 5 })
    await expect(settle(c.executeQuery(query))).resolves.toEqual({ rows: [] })
  })
})

describe('the pause between attempts', () => {
  it('is drawn from 1 up to a bound that doubles from the base to the cap', async () => {
    conn.executeQuery.mockRejectedValue(busy())
    const { c } = await connect({ ceilingMs: 400, baseDelayMs: 5, maxDelayMs: 40 })
    await settle(c.executeQuery(query)).catch(() => undefined)
    // randomInt's upper end is exclusive, so [1, 6) is a pause of 1..5.
    expect(fake.draws.slice(0, 6)).toEqual([
      [1, 6],
      [1, 11],
      [1, 21],
      [1, 41],
      [1, 41],
      [1, 41],
    ])
  })
})
