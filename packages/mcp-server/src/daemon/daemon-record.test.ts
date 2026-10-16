import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CHMOD_IS_OBSERVABLE } from '../shared/test-utils/chmod-is-observable.js'
import {
  describeOccupant,
  describeUnconfirmed,
  opensSentence,
  parseDaemonRecord,
} from './daemon-record.js'
import { getDaemonRecordPath } from './daemon-registry.js'

// Every pid below is a fake; a real process under the same number must not
// decide what the record is.
const gone = { isAlive: () => false }
const running = { isAlive: () => true, startMs: () => null }

describe('parseDaemonRecord', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'daemon-record-test-'))
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('returns "missing" when daemon.json does not exist', async () => {
    const result = await parseDaemonRecord(dataDir, gone)

    expect(result).toEqual({ kind: 'missing' })
  })

  // A directory others can write could hold anything under the record's name,
  // so it is never opened there; what the report owes is the fix, and whether
  // a file stands under that name.
  describe.skipIf(!CHMOD_IS_OBSERVABLE)('in a data dir others can write', () => {
    it.each([
      ['a record', true],
      ['no record', false],
    ])('returns "unreadable" naming the fix, over %s', async (_, withRecord) => {
      if (withRecord) await writeFile(getDaemonRecordPath(dataDir), '{}', 'utf-8')
      await chmod(dataDir, 0o777)

      expect(await parseDaemonRecord(dataDir, running)).toEqual({
        kind: 'unreadable',
        error: expect.objectContaining({
          message: expect.stringContaining(`chmod 700 ${dataDir}`),
        }),
        recordFound: withRecord,
      })
    })
  })

  it('returns "malformed" for invalid JSON', async () => {
    await writeFile(getDaemonRecordPath(dataDir), '{ not valid json', 'utf-8')

    const result = await parseDaemonRecord(dataDir, gone)

    expect(result.kind).toBe('malformed')
  })

  it('returns "malformed" when the JSON is not an object', async () => {
    await writeFile(getDaemonRecordPath(dataDir), JSON.stringify('not-an-object'), 'utf-8')

    const result = await parseDaemonRecord(dataDir, gone)

    expect(result).toEqual({
      kind: 'malformed',
      message: 'Daemon record is not an object.',
    })
  })

  it('returns "malformed" when required base fields are missing', async () => {
    await writeFile(getDaemonRecordPath(dataDir), JSON.stringify({ pid: 123 }), 'utf-8')

    const result = await parseDaemonRecord(dataDir, gone)

    expect(result).toEqual({
      kind: 'malformed',
      message: 'Daemon record cannot be interpreted by this version, and its daemon is gone.',
    })
  })

  it('returns "token-missing" with the base record when the token is absent', async () => {
    const base = {
      pid: 123,
      socketPath: '/run/user/1000/whiteboard/d.sock',
      version: '0.1.0',
      startedAt: '2026-04-23T00:00:00.000Z',
    }
    await writeFile(getDaemonRecordPath(dataDir), JSON.stringify(base), 'utf-8')

    const result = await parseDaemonRecord(dataDir, gone)

    expect(result).toEqual({ kind: 'token-missing', record: base, liveness: { state: 'dead' } })
  })

  it('returns "token-missing" when the token is present but empty', async () => {
    const base = {
      pid: 123,
      socketPath: '/run/user/1000/whiteboard/d.sock',
      version: '0.1.0',
      startedAt: '2026-04-23T00:00:00.000Z',
      token: '',
    }
    await writeFile(getDaemonRecordPath(dataDir), JSON.stringify(base), 'utf-8')

    const result = await parseDaemonRecord(dataDir, gone)

    expect(result.kind).toBe('token-missing')
  })

  it('returns "malformed" for a present-but-wrong-typed token (not token-missing)', async () => {
    const record = {
      pid: 123,
      socketPath: '/run/user/1000/whiteboard/d.sock',
      version: '0.1.0',
      startedAt: '2026-04-23T00:00:00.000Z',
      token: 123,
    }
    await writeFile(getDaemonRecordPath(dataDir), JSON.stringify(record), 'utf-8')

    const result = await parseDaemonRecord(dataDir, gone)

    expect(result.kind).toBe('malformed')
  })

  it('returns "malformed" for a top-level JSON array', async () => {
    await writeFile(getDaemonRecordPath(dataDir), '[]', 'utf-8')

    const result = await parseDaemonRecord(dataDir, gone)

    expect(result).toEqual({ kind: 'malformed', message: 'Daemon record is not an object.' })
  })

  it('returns "valid" with the full record when all fields including token parse', async () => {
    const record = {
      pid: 123,
      socketPath: '/run/user/1000/whiteboard/d.sock',
      version: '0.1.0',
      startedAt: '2026-04-23T00:00:00.000Z',
      token: 'secret',
    }
    await writeFile(getDaemonRecordPath(dataDir), JSON.stringify(record), 'utf-8')

    const result = await parseDaemonRecord(dataDir, gone)

    expect(result).toEqual({ kind: 'valid', record, liveness: { state: 'dead' } })
  })

  // A record outlives a daemon that did not stop cleanly, so a usable one
  // still says whether its daemon is there; a reader is handed the answer
  // rather than having to remember to ask.
  it('carries whether the daemon a valid record names is still running', async () => {
    const record = {
      pid: 123,
      socketPath: '/run/user/1000/whiteboard/d.sock',
      version: '0.1.0',
      startedAt: '2026-04-23T00:00:00.000Z',
      token: 'secret',
    }
    await writeFile(getDaemonRecordPath(dataDir), JSON.stringify(record), 'utf-8')

    expect(await parseDaemonRecord(dataDir, running)).toEqual({
      kind: 'valid',
      record,
      liveness: { state: 'running' },
    })
  })

  it('returns "malformed" for an object that names no pid', async () => {
    await writeFile(getDaemonRecordPath(dataDir), JSON.stringify({ version: '1' }), 'utf-8')

    expect(await parseDaemonRecord(dataDir, running)).toEqual({
      kind: 'malformed',
      message: 'Daemon record is missing required fields.',
    })
  })

  describe('a record this build cannot interpret', () => {
    const record = {
      pid: 123,
      socketPath: '/run/user/1000/whiteboard/d.sock',
      version: '9.9.9',
      startedAt: '2026-04-23T00:00:00.000Z',
      token: 'secret',
      launch: 'packaged',
    }

    it('is reported with what it names while its daemon is running', async () => {
      await writeFile(getDaemonRecordPath(dataDir), JSON.stringify(record), 'utf-8')

      const { launch: _launch, ...named } = record
      expect(await parseDaemonRecord(dataDir, running)).toEqual({
        kind: 'uninterpretable',
        recorded: named,
        liveness: { state: 'running' },
      })
    })

    it('is malformed once its daemon is gone', async () => {
      await writeFile(getDaemonRecordPath(dataDir), JSON.stringify(record), 'utf-8')

      expect((await parseDaemonRecord(dataDir, gone)).kind).toBe('malformed')
    })
  })

  it('reports whether the daemon a token-less record names is still running', async () => {
    const base = {
      pid: 123,
      socketPath: '/run/user/1000/whiteboard/d.sock',
      version: '0.1.0',
      startedAt: '2026-04-23T00:00:00.000Z',
    }
    await writeFile(getDaemonRecordPath(dataDir), JSON.stringify(base), 'utf-8')

    expect(await parseDaemonRecord(dataDir, running)).toEqual({
      kind: 'token-missing',
      record: base,
      liveness: { state: 'running' },
    })
  })
})

describe('describeUnconfirmed', () => {
  it('names the pid that answered on the socket where the answer gave one', () => {
    expect(describeUnconfirmed({ state: 'unconfirmed', servingPid: 7 }, 5, '/s.sock')).toBe(
      'a daemon answers on /s.sock as pid 7, not as pid 5',
    )
  })

  it('says only that the recorded pid was not confirmed where the answer named none', () => {
    expect(describeUnconfirmed({ state: 'unconfirmed' }, 5, 'the recorded socket')).toBe(
      'a process holds the recorded socket but did not confirm it is pid 5',
    )
  })

  it('opens a sentence with the same clause', () => {
    expect(opensSentence(describeUnconfirmed({ state: 'unconfirmed' }, 5, '/s.sock'))).toBe(
      'A process holds /s.sock but did not confirm it is pid 5',
    )
  })

  it('says a process holds the socket, naming the recorded pid, where no pid answered', () => {
    expect(describeOccupant({ state: 'unconfirmed' }, 5, 'its socket /s.sock')).toBe(
      'a process holds its socket /s.sock but did not confirm it is pid 5',
    )
  })

  it('names the serving pid the way describeOccupant does', () => {
    const liveness = { state: 'unconfirmed', servingPid: 7 } as const
    expect(describeOccupant(liveness, 5, 'its socket /s.sock')).toBe(
      'a daemon answers on its socket /s.sock as pid 7',
    )
  })
})
