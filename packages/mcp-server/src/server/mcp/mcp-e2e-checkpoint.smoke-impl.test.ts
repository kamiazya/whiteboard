import { describe, expect, it } from 'vitest'
import { buildCheckpointChildEnv } from './mcp-e2e-checkpoint.smoke-impl.js'

describe('buildCheckpointChildEnv', () => {
  it('preserves the parent env, such as the smoke RPC timeout, and points the child at the data dir', () => {
    const processEnv = { PATH: '/usr/bin', WHITEBOARD_SMOKE_RPC_TIMEOUT_MS: '90000' }

    const childEnv = buildCheckpointChildEnv(processEnv, '/tmp/data-dir')

    expect(childEnv.WHITEBOARD_SMOKE_RPC_TIMEOUT_MS).toBe('90000')
    expect(childEnv.PATH).toBe('/usr/bin')
    expect(childEnv.WHITEBOARD_DATA_DIR).toBe('/tmp/data-dir')
  })

  it('does not invent a variable absent from the parent env', () => {
    const childEnv = buildCheckpointChildEnv({ PATH: '/usr/bin' }, '/tmp/data-dir')

    expect(childEnv.WHITEBOARD_SMOKE_RPC_TIMEOUT_MS).toBeUndefined()
  })
})
