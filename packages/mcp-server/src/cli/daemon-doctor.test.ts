import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { roundtrip } from '@kamiazya/whiteboard-daemon-client/api-contracts/roundtrip.test-helper'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ownedSocketPath, validParse } from '../daemon/_test-daemon-record.js'
import { answeringDaemonSocket } from '../daemon/_test-daemon-socket.js'
import { daemonDoctorResultSchema } from '../shared/api-contracts/daemon-doctor.js'
import { CHMOD_IS_OBSERVABLE } from '../shared/test-utils/chmod-is-observable.js'
import { runDaemonDoctor } from './daemon-doctor.js'

const SOCKET_PATH = ownedSocketPath()

// Tests inject isPidAlive and processStartMs, so no real process decides an
// answer; all but the last describe inject parseRecord too.

type ParseRecord = Parameters<typeof runDaemonDoctor>[0]['parseRecord']

const baseRecord = {
  pid: 12345,
  version: '1.0.0',
  startedAt: '2024-01-01T00:00:00.000Z',
  socketPath: SOCKET_PATH,
}
const validRecord = { ...baseRecord, token: 'tok' }

function runDoctor(
  parseRecord: ParseRecord,
  isPidAlive: () => boolean,
  runningVersion = baseRecord.version,
) {
  // Every fake pid here is the daemon; a real /proc entry under the same
  // number must not decide it.
  return runDaemonDoctor({
    dataDir: '/fake',
    parseRecord,
    isPidAlive,
    processStartMs: () => null,
    runningVersion,
  })
}

describe('runDaemonDoctor: record missing', () => {
  const parseMissing: ParseRecord = async () => ({ kind: 'missing' })

  it('returns exitCode 1 and ok=false when record is missing', async () => {
    const { result, exitCode } = await runDoctor(parseMissing, () => false)
    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.status).toBe('error')
  })

  it('includes a single check with id daemon.record and status error', async () => {
    const { result } = await runDoctor(parseMissing, () => false)
    expect(result.checks).toHaveLength(1)
    expect(result.checks[0]).toMatchObject({ id: 'daemon.record', status: 'error' })
  })

  it('check remediation mentions starting the daemon', async () => {
    const { result } = await runDoctor(parseMissing, () => false)
    expect(result.checks[0].remediation).toMatch(/daemon run/)
  })
})

describe('runDaemonDoctor: record malformed', () => {
  const parseMalformed: ParseRecord = async () => ({ kind: 'malformed', message: 'not json' })

  it('returns exitCode 1 and ok=false', async () => {
    const { result, exitCode } = await runDoctor(parseMalformed, () => false)
    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
  })

  it('check mentions removing/restarting the daemon', async () => {
    const { result } = await runDoctor(parseMalformed, () => false)
    expect(result.checks[0].remediation).toMatch(/restart/)
  })
})

describe('runDaemonDoctor: token missing', () => {
  const parseTokenMissing: ParseRecord = async () => ({
    kind: 'token-missing',
    record: baseRecord,
    liveness: { state: 'dead' },
  })

  it('returns exitCode 1 and ok=false', async () => {
    const { result, exitCode } = await runDoctor(parseTokenMissing, () => false)
    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
  })
})

describe('runDaemonDoctor: valid record, process alive', () => {
  const parseValid: ParseRecord = validParse(validRecord)

  it('returns exitCode 0 and ok=true when process is alive', async () => {
    const { result, exitCode } = await runDoctor(parseValid, () => true)
    expect(exitCode).toBe(0)
    expect(result.ok).toBe(true)
    expect(result.status).toBe('ok')
  })

  it('produces two checks: daemon.record and daemon.process', async () => {
    const { result } = await runDoctor(parseValid, () => true)
    expect(result.checks).toHaveLength(2)
    expect(result.checks[0].id).toBe('daemon.record')
    expect(result.checks[1].id).toBe('daemon.process')
  })

  it('both checks are ok when process is alive', async () => {
    const { result } = await runDoctor(parseValid, () => true)
    for (const check of result.checks) {
      expect(check.status).toBe('ok')
    }
  })

  it('schemaVersion is 1', async () => {
    const { result } = await runDoctor(parseValid, () => true)
    expect(result.schemaVersion).toBe(1)
  })
})

describe('runDaemonDoctor: valid record, process dead', () => {
  const parseValid: ParseRecord = validParse(validRecord)

  it('returns exitCode 1 and ok=false when process is dead', async () => {
    const { result, exitCode } = await runDoctor(parseValid, () => false)
    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.status).toBe('error')
  })

  it('daemon.process check is error when process is dead', async () => {
    const { result } = await runDoctor(parseValid, () => false)
    const processCheck = result.checks.find((c) => c.id === 'daemon.process')
    expect(processCheck?.status).toBe('error')
    expect(processCheck?.remediation).toMatch(/daemon run/)
  })

  it('daemon.record check is still ok when record is valid but process is dead', async () => {
    const { result } = await runDoctor(parseValid, () => false)
    const recordCheck = result.checks.find((c) => c.id === 'daemon.record')
    expect(recordCheck?.status).toBe('ok')
  })
})

describe('runDaemonDoctor: valid record, its pid taken by a later process', () => {
  const parseValid: ParseRecord = validParse(validRecord)
  const reused = () =>
    runDaemonDoctor({
      dataDir: '/fake',
      parseRecord: parseValid,
      isPidAlive: () => true,
      processStartMs: () => Date.parse(validRecord.startedAt) + 60_000,
      runningVersion: validRecord.version,
    })

  it('reports the daemon not running, as `daemon status` does, and exits 1', async () => {
    const { result, exitCode } = await reused()
    const processCheck = result.checks.find((c) => c.id === 'daemon.process')
    expect(processCheck?.status).toBe('error')
    expect(processCheck?.summary).toMatch(/another process/)
    expect(processCheck?.remediation).toMatch(/daemon run/)
    expect(result).toMatchObject({ ok: false, status: 'error' })
    expect(exitCode).toBe(1)
  })
})

// A forward clock step makes a live daemon read as having started after its
// record; its socket is asked, and here answers as another pid.
describe('runDaemonDoctor: a socket that answers as another pid', () => {
  it('reports the process check in error, naming the pid that answered, and exits 1', async () => {
    const daemon = await answeringDaemonSocket(validRecord.pid + 1, validRecord.token)
    const { result, exitCode } = await runDaemonDoctor({
      dataDir: '/fake',
      parseRecord: validParse({ ...validRecord, socketPath: daemon.socketPath }),
      isPidAlive: () => true,
      processStartMs: () => Date.parse(validRecord.startedAt) + 6_000,
      runningVersion: validRecord.version,
    })
    expect(result.checks).toContainEqual({
      id: 'daemon.process',
      status: 'error',
      summary: `A daemon answers on the recorded socket as pid ${validRecord.pid + 1}, not as pid ${validRecord.pid}, which the record names.`,
      remediation:
        'Stop the process serving the socket named in daemon.json, then start the daemon: whiteboard daemon run',
    })
    expect(result).toMatchObject({ ok: false, status: 'error' })
    expect(exitCode).toBe(1)
  })
})

describe('runDaemonDoctor: version skew', () => {
  const parseValid: ParseRecord = validParse(validRecord)

  it('reports a warning finding naming both versions when the daemon runs another build', async () => {
    const { result, exitCode } = await runDoctor(parseValid, () => true, '2.0.0')
    const versionCheck = result.checks.find((c) => c.id === 'daemon.version')
    expect(versionCheck?.status).toBe('warning')
    expect(versionCheck?.summary).toContain('1.0.0')
    expect(versionCheck?.summary).toContain('2.0.0')
    expect(versionCheck?.remediation).toMatch(/daemon stop/)
    expect(result.status).toBe('warning')
    // A skew is advice, not a failure: the daemon is up and answering.
    expect(result.ok).toBe(true)
    expect(exitCode).toBe(0)
  })

  it('adds no finding when the daemon runs this build', async () => {
    const { result } = await runDoctor(parseValid, () => true, '1.0.0')
    expect(result.checks.map((c) => c.id)).toEqual(['daemon.record', 'daemon.process'])
    expect(result.status).toBe('ok')
  })

  it('keeps the error status when the process is dead, whatever the versions', async () => {
    const { result, exitCode } = await runDoctor(parseValid, () => false, '2.0.0')
    expect(result.status).toBe('error')
    expect(exitCode).toBe(1)
  })

  it('round-trips the warning result through daemonDoctorResultSchema', async () => {
    const { result } = await runDoctor(parseValid, () => true, '2.0.0')
    expect(roundtrip(daemonDoctorResultSchema, result)).toEqual(result)
  })
})

describe('runDaemonDoctor: wire drift', () => {
  it('round-trips the missing-record result through daemonDoctorResultSchema', async () => {
    const parseMissing: ParseRecord = async () => ({ kind: 'missing' })
    const { result } = await runDoctor(parseMissing, () => false)
    expect(roundtrip(daemonDoctorResultSchema, result)).toEqual(result)
  })
})

// A person reads a remediation and types it. `--json` is the script form of
// `daemon run`; sending a person there prints a ready object instead of the
// one sentence that says the daemon is up.
describe('runDaemonDoctor: remediation is the human form of the command', () => {
  const records: readonly ParseRecord[] = [
    async () => ({ kind: 'missing' }),
    async () => ({ kind: 'malformed', message: 'not json' }),
    async () => ({ kind: 'token-missing', record: baseRecord, liveness: { state: 'dead' } }),
    validParse(validRecord),
  ]

  it('names `daemon run` without `--json` in every finding that tells a person to start it', async () => {
    const remediations: string[] = []
    for (const parseRecord of records) {
      const { result } = await runDoctor(parseRecord, () => false)
      for (const check of result.checks) {
        if (check.remediation !== undefined) remediations.push(check.remediation)
      }
    }
    // Four records, each reaching a start-the-daemon finding: a count far
    // below that means the scenarios stopped reaching the remediation.
    expect(remediations.filter((text) => /daemon run/.test(text))).toHaveLength(4)
    expect(remediations.filter((text) => text.includes('--json'))).toEqual([])
  })
})

// A record this build cannot interpret is likeliest another version's, and
// that daemon may still be serving: removing its record leaves it running with
// no record, where `daemon run` collides with its socket and its own version's
// `daemon stop` finds nothing to stop.
describe('runDaemonDoctor: a record this build cannot interpret', () => {
  let dataDir: string
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'daemon-doctor-record-'))
  })
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  async function doctorOver(record: Record<string, unknown>, isPidAlive: boolean) {
    await writeFile(join(dataDir, 'daemon.json'), JSON.stringify(record))
    return runDaemonDoctor({
      dataDir,
      isPidAlive: () => isPidAlive,
      processStartMs: () => null,
      runningVersion: baseRecord.version,
    })
  }
  const otherVersion = { ...validRecord, version: '9.9.9', launch: 'packaged' }

  it('names the running daemon and never advises removing its record', async () => {
    const { result, exitCode } = await doctorOver(otherVersion, true)
    expect(exitCode).toBe(1)
    expect(result.checks).toEqual([
      expect.objectContaining({
        id: 'daemon.record',
        status: 'error',
        summary: expect.stringContaining(`pid ${validRecord.pid}`),
        remediation: expect.stringMatching(/stop it with that version/),
      }),
    ])
    expect(result.checks[0]?.remediation).not.toMatch(/[Rr]emove/)
  })

  it('calls it malformed, to be removed, once the daemon it names is gone', async () => {
    const { result } = await doctorOver(otherVersion, false)
    expect(result.checks[0]?.remediation).toMatch(/Remove the daemon record/)
  })

  it('does not send a person to `daemon run` over a live record that has no token', async () => {
    const { token: _token, ...noToken } = validRecord
    const { result } = await doctorOver(noToken, true)
    expect(result.checks[0]).toMatchObject({ id: 'daemon.record', status: 'error' })
    expect(result.checks[0]?.remediation).toMatch(/^Stop that daemon/)
  })
})

// The ownership check refuses the directory before the record is opened, so
// whether a daemon still serves there is unknown: removing its record would
// let the next `daemon run` start beside it.
describe.skipIf(!CHMOD_IS_OBSERVABLE)('runDaemonDoctor: a data dir it refuses to read', () => {
  let dataDir: string
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'daemon-doctor-unreadable-'))
  })
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it.each([
    ['holding the record of a live daemon', true],
    ['holding no record', false],
  ])('names the cause and its fix, %s, and never advises removal', async (_, withRecord) => {
    if (withRecord) {
      await writeFile(
        join(dataDir, 'daemon.json'),
        JSON.stringify({ ...validRecord, pid: process.pid }),
      )
    }
    await chmod(dataDir, 0o777)
    const { result, exitCode } = await runDaemonDoctor({ dataDir })
    expect(exitCode).toBe(1)
    expect(result.checks).toEqual([
      expect.objectContaining({
        id: 'daemon.record',
        status: 'error',
        summary: 'Daemon record cannot be read.',
        detail: expect.stringContaining(`chmod 700 ${dataDir}`),
      }),
    ])
    expect(JSON.stringify(result)).not.toMatch(/[Rr]emove|malformed/)
  })
})
