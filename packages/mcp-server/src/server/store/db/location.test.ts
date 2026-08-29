import { describe, expect, it } from 'vitest'
import { DB_URL_AUTH_TOKEN_ENV, DB_URL_ENV, resolveDatabaseLocation } from './location.js'

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
