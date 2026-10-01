import { describe, expect, it } from 'vitest'
import {
  parseDaemonReplicaKeyArgs,
  parseDaemonReplicaTierArgs,
  parseDaemonRunArgs,
  parseDaemonSubcommandArgs,
  parseDaemonSupportBundleArgs,
  redactFlagValue,
} from './argv.js'

// ---------------------------------------------------------------------------
// redactFlagValue
// ---------------------------------------------------------------------------

describe('redactFlagValue', () => {
  it('returns [REDACTED_ARGUMENT] for a bare positional argument', () => {
    expect(redactFlagValue('some-value')).toBe('[REDACTED_ARGUMENT]')
  })

  it('returns the flag name as-is when there is no = sign', () => {
    expect(redactFlagValue('--unknown-flag')).toBe('--unknown-flag')
  })

  it('replaces the value with … when flag has an inline value', () => {
    expect(redactFlagValue('--token=secret123')).toBe('--token=…')
  })

  it('handles flags with empty inline value', () => {
    expect(redactFlagValue('--flag=')).toBe('--flag=…')
  })

  it('does not redact flags without -- prefix', () => {
    expect(redactFlagValue('-v')).toBe('[REDACTED_ARGUMENT]')
  })
})

// ---------------------------------------------------------------------------
// parseDaemonSubcommandArgs  (used by daemon status / doctor / stop)
// ---------------------------------------------------------------------------

describe('parseDaemonSubcommandArgs', () => {
  it('accepts --json alone', () => {
    const result = parseDaemonSubcommandArgs(['--json'], 'status')
    expect(result).toEqual({ kind: 'ok', json: true, dataDir: undefined })
  })

  it('accepts --json with --data-dir=<value>', () => {
    const result = parseDaemonSubcommandArgs(['--json', '--data-dir=/custom/dir'], 'status')
    expect(result).toEqual({ kind: 'ok', json: true, dataDir: '/custom/dir' })
  })

  it('accepts --data-dir=<value> before --json', () => {
    const result = parseDaemonSubcommandArgs(['--data-dir=/foo', '--json'], 'status')
    expect(result).toEqual({ kind: 'ok', json: true, dataDir: '/foo' })
  })

  it('returns usage-error when --json is missing', () => {
    const result = parseDaemonSubcommandArgs([], 'status')
    expect(result).toMatchObject({ kind: 'usage-error' })
  })

  it('includes commandName in the missing-json error message', () => {
    const result = parseDaemonSubcommandArgs([], 'doctor') as { kind: string; message: string }
    expect(result.message).toContain('doctor')
  })

  it('returns usage-error when --json is duplicated', () => {
    const result = parseDaemonSubcommandArgs(['--json', '--json'], 'status')
    expect(result).toMatchObject({ kind: 'usage-error' })
    expect((result as { kind: string; message: string }).message).toContain('--json')
  })

  it('returns usage-error when --data-dir is given without = (space form)', () => {
    const result = parseDaemonSubcommandArgs(['--json', '--data-dir'], 'status')
    expect(result).toMatchObject({ kind: 'usage-error' })
    expect((result as { kind: string; message: string }).message).toContain('--data-dir')
  })

  it('returns usage-error when --data-dir= has an empty value', () => {
    const result = parseDaemonSubcommandArgs(['--json', '--data-dir='], 'status')
    expect(result).toMatchObject({ kind: 'usage-error' })
  })

  it('returns usage-error when --data-dir is specified more than once', () => {
    const result = parseDaemonSubcommandArgs(['--json', '--data-dir=/a', '--data-dir=/b'], 'status')
    expect(result).toMatchObject({ kind: 'usage-error' })
    expect((result as { kind: string; message: string }).message).toContain(
      '--data-dir specified more than once',
    )
  })

  it('returns usage-error for an unknown flag', () => {
    const result = parseDaemonSubcommandArgs(['--json', '--bogus'], 'status')
    expect(result).toMatchObject({ kind: 'usage-error' })
    expect((result as { kind: string; message: string }).message).toContain('Unknown argument')
  })

  it('redacts the value of an unknown flag with an inline value', () => {
    const result = parseDaemonSubcommandArgs(['--json', '--secret=hunter2'], 'status') as {
      kind: string
      message: string
    }
    expect(result.kind).toBe('usage-error')
    // The value must not appear in the error message
    expect(result.message).not.toContain('hunter2')
    expect(result.message).toContain('--secret=…')
  })
})

// ---------------------------------------------------------------------------
// parseDaemonRunArgs
// ---------------------------------------------------------------------------

describe('parseDaemonRunArgs', () => {
  it('accepts --json alone', () => {
    const result = parseDaemonRunArgs(['--json'])
    expect(result).toEqual({
      kind: 'ok',
      json: true,
      dataDir: undefined,
      tokenStdin: false,
      noOpen: false,
    })
  })

  it('accepts all known flags together', () => {
    const result = parseDaemonRunArgs([
      '--json',
      '--data-dir=/tmp/data',
      '--token-stdin',
      '--no-open',
    ])
    expect(result).toEqual({
      kind: 'ok',
      json: true,
      dataDir: '/tmp/data',
      tokenStdin: true,
      noOpen: true,
    })
  })

  it('returns usage-error when --no-open is duplicated', () => {
    const result = parseDaemonRunArgs(['--json', '--no-open', '--no-open'])
    expect(result).toMatchObject({ kind: 'usage-error' })
    expect((result as { kind: string; message: string }).message).toContain('--no-open')
  })

  it('returns usage-error when --json is missing', () => {
    const result = parseDaemonRunArgs([])
    expect(result).toMatchObject({ kind: 'usage-error' })
  })

  it('returns usage-error when --json is duplicated', () => {
    const result = parseDaemonRunArgs(['--json', '--json'])
    expect(result).toMatchObject({ kind: 'usage-error' })
    expect((result as { kind: string; message: string }).message).toContain('--json')
  })

  it('returns usage-error when --token-stdin is duplicated', () => {
    const result = parseDaemonRunArgs(['--json', '--token-stdin', '--token-stdin'])
    expect(result).toMatchObject({ kind: 'usage-error' })
    expect((result as { kind: string; message: string }).message).toContain('--token-stdin')
  })

  it('returns usage-error when --token flag is used (security)', () => {
    const result = parseDaemonRunArgs(['--json', '--token=secret'])
    expect(result).toMatchObject({ kind: 'usage-error' })
    expect((result as { kind: string; message: string }).message).not.toContain('secret')
  })

  it('returns usage-error when bare --token flag is used', () => {
    const result = parseDaemonRunArgs(['--json', '--token'])
    expect(result).toMatchObject({ kind: 'usage-error' })
  })

  // ADR-0050: the local daemon listens on its socket and no TCP port, so there
  // is no port or host to choose — and a script still passing one is told so
  // rather than having it silently ignored.
  it.each(['--port=4000', '--host=127.0.0.1'])('refuses %s as an unknown argument', (flag) => {
    const result = parseDaemonRunArgs(['--json', flag])
    expect(result).toMatchObject({ kind: 'usage-error' })
  })

  it('returns usage-error when --data-dir is given without = (space form)', () => {
    const result = parseDaemonRunArgs(['--json', '--data-dir'])
    expect(result).toMatchObject({ kind: 'usage-error' })
  })

  it('returns usage-error when --data-dir= has an empty value', () => {
    const result = parseDaemonRunArgs(['--json', '--data-dir='])
    expect(result).toMatchObject({ kind: 'usage-error' })
  })

  it('returns usage-error when --data-dir is duplicated', () => {
    const result = parseDaemonRunArgs(['--json', '--data-dir=/a', '--data-dir=/b'])
    expect(result).toMatchObject({ kind: 'usage-error' })
  })

  it('returns usage-error for an unknown flag', () => {
    const result = parseDaemonRunArgs(['--json', '--unknown'])
    expect(result).toMatchObject({ kind: 'usage-error' })
  })

  it('redacts the value of an unknown flag with inline value', () => {
    const result = parseDaemonRunArgs(['--json', '--secret=hunter2']) as {
      kind: string
      message: string
    }
    expect(result.kind).toBe('usage-error')
    expect(result.message).not.toContain('hunter2')
  })
})

// ---------------------------------------------------------------------------
// parseDaemonReplicaKeyArgs / parseDaemonReplicaTierArgs
// ---------------------------------------------------------------------------

describe('parseDaemonReplicaKeyArgs', () => {
  it('requires --json and --workspace', () => {
    expect(parseDaemonReplicaKeyArgs(['--json', '--workspace=ws-1'])).toEqual({
      kind: 'ok',
      json: true,
      workspaceId: 'ws-1',
      dataDir: undefined,
    })
    expect(parseDaemonReplicaKeyArgs(['--workspace=ws-1'])).toMatchObject({
      kind: 'usage-error',
      message: expect.stringContaining('--json'),
    })
    expect(parseDaemonReplicaKeyArgs(['--json'])).toEqual({
      kind: 'usage-error',
      message: '--workspace=<id> is required',
    })
  })

  it('carries --data-dir through', () => {
    expect(
      parseDaemonReplicaKeyArgs(['--json', '--workspace=ws-1', '--data-dir=/data']),
    ).toMatchObject({ kind: 'ok', dataDir: '/data' })
  })
})

describe('parseDaemonReplicaTierArgs', () => {
  it('accepts each tier, and `default` as the explicit clear', () => {
    for (const tier of ['no-offline', 'offline', 'bounded'] as const) {
      expect(parseDaemonReplicaTierArgs(['--json', '--workspace=ws-1', `--tier=${tier}`])).toEqual({
        kind: 'ok',
        json: true,
        workspaceId: 'ws-1',
        tier,
        dataDir: undefined,
      })
    }
    expect(
      parseDaemonReplicaTierArgs(['--json', '--workspace=ws-1', '--tier=default']),
    ).toMatchObject({ kind: 'ok', tier: null })
  })

  it('refuses a tier the daemon does not know, naming the ones it does', () => {
    expect(parseDaemonReplicaTierArgs(['--json', '--workspace=ws-1', '--tier=sometimes'])).toEqual({
      kind: 'usage-error',
      message:
        '--tier must be one of no-offline, offline, bounded, or default (clears the override)',
    })
    expect(parseDaemonReplicaTierArgs(['--json', '--workspace=ws-1'])).toEqual({
      kind: 'usage-error',
      message: '--tier=<no-offline|offline|bounded|default> is required',
    })
  })
})

// ---------------------------------------------------------------------------
// parseDaemonSupportBundleArgs
// ---------------------------------------------------------------------------

describe('parseDaemonSupportBundleArgs', () => {
  it('accepts --json and --output-dir=<value>', () => {
    const result = parseDaemonSupportBundleArgs(['--json', '--output-dir=/tmp/bundle'])
    expect(result).toEqual({ kind: 'ok', json: true, outputDir: '/tmp/bundle', dataDir: undefined })
  })

  it('accepts --data-dir in addition to required flags', () => {
    const result = parseDaemonSupportBundleArgs([
      '--json',
      '--output-dir=/tmp/bundle',
      '--data-dir=/custom',
    ])
    expect(result).toEqual({
      kind: 'ok',
      json: true,
      outputDir: '/tmp/bundle',
      dataDir: '/custom',
    })
  })

  it('returns usage-error when --json is missing', () => {
    const result = parseDaemonSupportBundleArgs(['--output-dir=/tmp/bundle'])
    expect(result).toMatchObject({ kind: 'usage-error' })
  })

  it('returns usage-error when --output-dir is missing (even with --json)', () => {
    const result = parseDaemonSupportBundleArgs(['--json'])
    expect(result).toMatchObject({ kind: 'usage-error' })
    expect((result as { kind: string; message: string }).message).toContain('--output-dir')
  })

  it('returns usage-error when --json is duplicated', () => {
    const result = parseDaemonSupportBundleArgs(['--json', '--json', '--output-dir=/tmp/bundle'])
    expect(result).toMatchObject({ kind: 'usage-error' })
  })

  it('returns usage-error when --output-dir is given without = (space form)', () => {
    const result = parseDaemonSupportBundleArgs(['--json', '--output-dir'])
    expect(result).toMatchObject({ kind: 'usage-error' })
  })

  it('returns usage-error when --output-dir= has an empty value', () => {
    const result = parseDaemonSupportBundleArgs(['--json', '--output-dir='])
    expect(result).toMatchObject({ kind: 'usage-error' })
  })

  it('returns usage-error when --output-dir is duplicated', () => {
    const result = parseDaemonSupportBundleArgs(['--json', '--output-dir=/a', '--output-dir=/b'])
    expect(result).toMatchObject({ kind: 'usage-error' })
    expect((result as { kind: string; message: string }).message).toContain(
      '--output-dir specified more than once',
    )
  })

  it('returns usage-error when --data-dir is given without = (space form)', () => {
    const result = parseDaemonSupportBundleArgs(['--json', '--output-dir=/tmp/b', '--data-dir'])
    expect(result).toMatchObject({ kind: 'usage-error' })
  })

  it('returns usage-error when --data-dir= has an empty value', () => {
    const result = parseDaemonSupportBundleArgs(['--json', '--output-dir=/tmp/b', '--data-dir='])
    expect(result).toMatchObject({ kind: 'usage-error' })
  })

  it('returns usage-error when --data-dir is duplicated', () => {
    const result = parseDaemonSupportBundleArgs([
      '--json',
      '--output-dir=/tmp/b',
      '--data-dir=/a',
      '--data-dir=/b',
    ])
    expect(result).toMatchObject({ kind: 'usage-error' })
  })

  it('returns usage-error for an unknown flag', () => {
    const result = parseDaemonSupportBundleArgs(['--json', '--output-dir=/tmp/b', '--bogus'])
    expect(result).toMatchObject({ kind: 'usage-error' })
    expect((result as { kind: string; message: string }).message).toContain('Unknown argument')
  })
})
