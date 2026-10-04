import { type Client, type Config, createClient } from '@libsql/client'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import {
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type TransactionSettings,
} from 'kysely'

/**
 * How long a write waits for another process's write lock.
 *
 * The wait is made HERE, between attempts, and not by SQLite's own
 * `busy_timeout`: libsql's `file:` client runs a statement synchronously on the
 * calling thread, so a busy_timeout holds the whole event loop for its
 * duration — measured, no timer tick at all across a 1023ms wait — and the
 * daemon stops answering every other request while one write waits. An
 * attempt without a timeout returns at once, so awaiting a timer between
 * attempts is what keeps the loop serving.
 *
 * `ceilingMs` stays well under a client's request timeout: a database that is
 * still locked after it is a writer that is stuck rather than slow, and the
 * caller is better told so than kept waiting.
 */
interface BusyRetryPolicy {
  ceilingMs: number
  baseDelayMs: number
  maxDelayMs: number
}

const DEFAULT_BUSY_RETRY: BusyRetryPolicy = {
  ceilingMs: 2_000,
  baseDelayMs: 5,
  maxDelayMs: 100,
}

/**
 * The database stayed locked by another process for the whole retry budget.
 *
 * Keeps `code: 'SQLITE_BUSY'`, which is what a caller matches on, so one that
 * already stands down on that code (the leader lease, the workspace tail) reads
 * it the same way; `waitedMs` and `attempts` are what an operator needs to tell
 * contention from a stuck holder.
 */
class DatabaseBusyError extends Error {
  readonly code = 'SQLITE_BUSY'
  readonly waitedMs: number
  readonly attempts: number

  constructor(waitedMs: number, attempts: number, cause: unknown) {
    super(
      `database stayed locked by another process for ${waitedMs}ms across ${attempts} attempts`,
      { cause },
    )
    this.name = 'DatabaseBusyError'
    this.waitedMs = waitedMs
    this.attempts = attempts
  }
}

/** libsql reports the primary code in `code` and any extended one in `extendedCode`. */
function isSqliteBusy(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const { code, extendedCode } = err as { code?: unknown; extendedCode?: unknown }
  return [code, extendedCode].some((c) => typeof c === 'string' && c.startsWith('SQLITE_BUSY'))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Run `attempt`, again after a jittered, growing pause for as long as it
 * answers SQLITE_BUSY and the budget lasts.
 *
 * Full jitter (a uniform draw up to the current bound) rather than a fixed
 * step, because the processes that collide are the same two every time and a
 * fixed step makes them collide again on the same beat.
 *
 * `onBusy` runs after every refusal, before the pause or the final throw.
 */
async function retryWhileBusy<T>(
  attempt: () => Promise<T>,
  policy: BusyRetryPolicy = DEFAULT_BUSY_RETRY,
  onBusy: () => Promise<void> = async () => {},
): Promise<T> {
  const startedAt = performance.now()
  for (let attempts = 1; ; attempts++) {
    try {
      return await attempt()
    } catch (err) {
      if (!isSqliteBusy(err)) throw err
      await onBusy()
      const waitedMs = performance.now() - startedAt
      const bound = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempts - 1))
      const delayMs = Math.max(1, Math.ceil(Math.random() * bound))
      if (waitedMs + delayMs > policy.ceilingMs) {
        throw new DatabaseBusyError(Math.round(waitedMs), attempts, err)
      }
      await sleep(delayMs)
    }
  }
}

interface RetryingConnection extends DatabaseConnection {
  readonly inner: DatabaseConnection
  inTransaction: boolean
}

/**
 * A connection that retries a statement refused as busy, outside a
 * transaction only: inside one the write lock is already held, and a busy
 * answer there means the snapshot the transaction read is stale, which no
 * repeat of the one statement can mend.
 */
function retryingConnection(
  inner: DatabaseConnection,
  policy: BusyRetryPolicy,
  onBusy: () => Promise<void>,
): RetryingConnection {
  const connection: RetryingConnection = {
    inner,
    inTransaction: false,
    executeQuery: <R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> =>
      connection.inTransaction
        ? inner.executeQuery<R>(compiledQuery)
        : retryWhileBusy(() => inner.executeQuery<R>(compiledQuery), policy, onBusy),
    streamQuery: <R>(compiledQuery: CompiledQuery, chunkSize: number) =>
      inner.streamQuery<R>(compiledQuery, chunkSize),
  }
  return connection
}

function retryingDriver(inner: Driver, client: Client, policy: BusyRetryPolicy): Driver {
  // A statement refused as busy is left unfinished on the client's shared
  // connection, and that connection's next explicit COMMIT then fails with
  // "cannot commit transaction - SQL statements in progress" — measured: three
  // refused statements, then a transaction that begins and writes fine and
  // cannot commit, until the connection is replaced. Replacing it here, after
  // each refusal, turns a retried write into exactly one write and not into a
  // later transaction's failure. Safe between awaits: a statement is
  // synchronous, and a transaction owns a connection of its own.
  const replaceConnection = async (): Promise<void> => {
    await client.reconnect()
  }

  return {
    init: () => inner.init(),
    async acquireConnection() {
      return retryingConnection(await inner.acquireConnection(), policy, replaceConnection)
    },
    // The write lock is taken here (`BEGIN IMMEDIATE`), so this is where a
    // transaction meets another process's, and where it is waited for.
    async beginTransaction(connection, settings: TransactionSettings) {
      const retrying = connection as RetryingConnection
      await retryWhileBusy(
        () => inner.beginTransaction(retrying.inner, settings),
        policy,
        replaceConnection,
      )
      retrying.inTransaction = true
    },
    async commitTransaction(connection) {
      const retrying = connection as RetryingConnection
      try {
        await inner.commitTransaction(retrying.inner)
      } finally {
        retrying.inTransaction = false
      }
    },
    async rollbackTransaction(connection) {
      const retrying = connection as RetryingConnection
      try {
        await inner.rollbackTransaction(retrying.inner)
      } finally {
        retrying.inTransaction = false
      }
    },
    releaseConnection: (connection) =>
      inner.releaseConnection((connection as RetryingConnection).inner),
    // The dialect was handed the client rather than building it, so it does
    // not close it; this driver made it and does.
    async destroy() {
      await inner.destroy()
      client.close()
    },
  }
}

/**
 * The libSQL dialect (the same adapter, introspector and compiler as
 * `@libsql/kysely-libsql`'s, which is also the driver underneath) with every
 * statement and transaction start made to wait out another process's write
 * lock — the one place a store write goes through, so no call site carries a
 * retry of its own.
 */
export function busyRetryingDialect(
  config: Config,
  policy: BusyRetryPolicy = DEFAULT_BUSY_RETRY,
): Dialect {
  return {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => {
      const client = createClient(config)
      return retryingDriver(new LibsqlDialect({ client }).createDriver(), client, policy)
    },
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  }
}
