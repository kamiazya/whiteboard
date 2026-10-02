import { roundtrip } from '@kamiazya/whiteboard-daemon-client/api-contracts/roundtrip.test-helper'
import { describe, expect, it } from 'vitest'
import { daemonDoctorResultSchema } from '../shared/api-contracts/daemon-doctor.js'
import { runDaemonDoctor } from './daemon-doctor.js'

// All tests inject parseRecord and isPidAlive — no filesystem or process access.

type ParseRecord = Parameters<typeof runDaemonDoctor>[0]['parseRecord']

const baseRecord = {
  pid: 12345,
  version: '1.0.0',
  startedAt: '2024-01-01T00:00:00.000Z',
  socketPath: '/fake/daemon.sock',
}
const validRecord = { ...baseRecord, token: 'tok' }

function runDoctor(
  parseRecord: ParseRecord,
  isPidAlive: () => boolean,
  runningVersion = baseRecord.version,
) {
  return runDaemonDoctor({ dataDir: '/fake', parseRecord, isPidAlive, runningVersion })
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
  const parseTokenMissing: ParseRecord = async () => ({ kind: 'token-missing', record: baseRecord })

  it('returns exitCode 1 and ok=false', async () => {
    const { result, exitCode } = await runDoctor(parseTokenMissing, () => false)
    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
  })
})

describe('runDaemonDoctor: valid record, process alive', () => {
  const parseValid: ParseRecord = async () => ({ kind: 'valid', record: validRecord })

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
  const parseValid: ParseRecord = async () => ({ kind: 'valid', record: validRecord })

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

describe('runDaemonDoctor: version skew', () => {
  const parseValid: ParseRecord = async () => ({ kind: 'valid', record: validRecord })

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
    async () => ({ kind: 'token-missing', record: baseRecord }),
    async () => ({ kind: 'valid', record: validRecord }),
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
