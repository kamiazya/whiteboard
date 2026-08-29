import { describe, expect, it } from 'vitest'
import {
  DB_URL_AUTH_TOKEN_ENV,
  DB_URL_ENV,
  databaseIsInsideDataDir,
  resolveDatabaseLocation,
} from './location.js'

const DATA_DIR = '/var/lib/whiteboard'

describe('resolveDatabaseLocation', () => {
  it('defaults to the data directory, which is what one daemon has always used', () => {
    expect(resolveDatabaseLocation(DATA_DIR, {})).toEqual({
      url: 'file:/var/lib/whiteboard/whiteboard.db',
    })
  })

  it('accepts a libsql server, which is what more than one instance needs', () => {
    expect(
      resolveDatabaseLocation(DATA_DIR, {
        [DB_URL_ENV]: 'libsql://db.example.com',
        [DB_URL_AUTH_TOKEN_ENV]: 'secret',
      }),
    ).toEqual({ url: 'libsql://db.example.com', authToken: 'secret' })
  })

  it('accepts https, and http only on loopback', () => {
    expect(resolveDatabaseLocation(DATA_DIR, { [DB_URL_ENV]: 'https://db.example.com' }).url).toBe(
      'https://db.example.com',
    )
    expect(resolveDatabaseLocation(DATA_DIR, { [DB_URL_ENV]: 'http://127.0.0.1:8080' }).url).toBe(
      'http://127.0.0.1:8080',
    )
  })

  /**
   * A plaintext connection to a remote database carries the auth token and
   * every row over the wire. Loopback is the local sqld a developer runs; a
   * remote host over `http:` is a mistake worth refusing.
   */
  it('refuses plaintext http to a host that is not loopback', () => {
    expect(() =>
      resolveDatabaseLocation(DATA_DIR, { [DB_URL_ENV]: 'http://db.example.com' }),
    ).toThrow(/http/i)
  })

  /**
   * The failure mode a fallback would create is the worst one available: two
   * instances each quietly opening their OWN local file, diverging with no
   * error anywhere, and every guarantee this PR built silently not applying
   * because they were never looking at the same record.
   */
  it('throws on an unusable value rather than falling back to the local file', () => {
    for (const raw of ['postgres://db', 'not a url', 'db.example.com', '://x']) {
      expect(() => resolveDatabaseLocation(DATA_DIR, { [DB_URL_ENV]: raw })).toThrow()
    }
  })

  it('treats an empty or whitespace value as unset', () => {
    expect(resolveDatabaseLocation(DATA_DIR, { [DB_URL_ENV]: '   ' }).url).toBe(
      'file:/var/lib/whiteboard/whiteboard.db',
    )
  })

  it('omits the auth token when none is configured, rather than sending an empty one', () => {
    const resolved = resolveDatabaseLocation(DATA_DIR, {
      [DB_URL_ENV]: 'libsql://db.example.com',
      [DB_URL_AUTH_TOKEN_ENV]: '  ',
    })
    expect(resolved).toEqual({ url: 'libsql://db.example.com' })
  })
})

/**
 * Whether a copy of the data directory would carry the rows with it.
 *
 * The question every whole-directory operation has to ask and until now did
 * not: `whiteboard server backup` copies the data directory, so once the rows
 * live anywhere else the copy is blobs alone — and the operator is told it
 * succeeded.
 */
describe('databaseIsInsideDataDir', () => {
  it('is true for the default, which is the file in the data directory', () => {
    expect(databaseIsInsideDataDir(DATA_DIR, {})).toBe(true)
  })

  it('is true for a file: URL naming that same file explicitly', () => {
    expect(
      databaseIsInsideDataDir(DATA_DIR, {
        [DB_URL_ENV]: 'file:/var/lib/whiteboard/whiteboard.db',
      }),
    ).toBe(true)
  })

  it('is false for a remote database', () => {
    for (const raw of [
      'libsql://db.example.com',
      'https://db.example.com',
      'http://127.0.0.1:8080',
    ]) {
      expect(databaseIsInsideDataDir(DATA_DIR, { [DB_URL_ENV]: raw })).toBe(false)
    }
  })

  /**
   * A file: URL is not automatically inside: pointed at another path it is as
   * absent from the copy as a remote server is.
   */
  it('is false for a file: URL pointing somewhere else', () => {
    expect(
      databaseIsInsideDataDir(DATA_DIR, { [DB_URL_ENV]: 'file:/srv/elsewhere/whiteboard.db' }),
    ).toBe(false)
  })

  /**
   * Fail closed. An answer of "inside" is what lets a whole-directory copy
   * proceed, so anything this function cannot read has to be the other
   * answer — a refused backup is recoverable, a believed empty one is not.
   */
  it('is false for a value it cannot resolve to a path', () => {
    expect(databaseIsInsideDataDir(DATA_DIR, { [DB_URL_ENV]: 'file:relative.db' })).toBe(false)
    expect(databaseIsInsideDataDir(DATA_DIR, { [DB_URL_ENV]: 'postgres://db' })).toBe(false)
  })
})
