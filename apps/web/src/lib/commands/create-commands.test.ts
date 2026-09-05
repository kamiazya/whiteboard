// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createWhiteboardCommands } from './create-commands.js'
import { CommandError, type WhiteboardCommandDeps } from './types.js'

function baseDeps(overrides: Partial<WhiteboardCommandDeps> = {}): WhiteboardCommandDeps {
  return {
    provider: { kind: 'browser' },
    canvas: { documentId: 'c1', name: 'Canvas 1' },
    ...overrides,
  }
}

function refOf(deps: WhiteboardCommandDeps): { current: WhiteboardCommandDeps } {
  return { current: deps }
}

describe('createWhiteboardCommands.getAppContext', () => {
  it('projects a browser provider and canvas without leaking capabilities', async () => {
    const depsRef = refOf(baseDeps())
    const commands = createWhiteboardCommands(depsRef)

    const result = await commands.getAppContext()

    expect(result).toEqual({
      provider: { mode: 'browser' },
      canvas: { kind: 'browser', documentId: 'c1' },
    })
  })

  it('projects a daemon provider field-by-field, excluding daemonBaseUrl even though ProviderState carries one', async () => {
    const depsRef = refOf(
      baseDeps({
        provider: {
          kind: 'daemon',
          daemonBaseUrl: 'http://127.0.0.1:9999',
        },
        canvas: { workspaceId: 'ws1', documentId: 'my-canvas', name: 'my-canvas' },
      }),
    )
    const commands = createWhiteboardCommands(depsRef)

    const result = await commands.getAppContext()

    expect(result).toEqual({
      provider: { mode: 'daemon' },
      canvas: { kind: 'daemon', workspaceId: 'ws1', path: 'my-canvas' },
    })
    const serialized = JSON.stringify(result).toLowerCase()
    expect(serialized).not.toContain('daemonbaseurl')
    expect(serialized).not.toContain('9999')
  })

  it('returns canvas: null when no canvas is selected, without throwing', async () => {
    const depsRef = refOf(baseDeps({ canvas: null }))
    const commands = createWhiteboardCommands(depsRef)

    const result = await commands.getAppContext()

    expect(result.canvas).toBeNull()
  })

  it('throws an invalid-provider-state CommandError rather than misreporting mode for an invalid-config provider', async () => {
    const depsRef = refOf(
      baseDeps({
        provider: { kind: 'invalid-config', message: 'bad config' },
      }),
    )
    const commands = createWhiteboardCommands(depsRef)

    await expect(commands.getAppContext()).rejects.toMatchObject({
      code: 'invalid-provider-state',
    })
    await expect(commands.getAppContext()).rejects.toBeInstanceOf(CommandError)
  })

  it('throws an invalid-provider-state CommandError when canvas.kind would disagree with provider.mode', async () => {
    // canvas.kind is derived from the presence of workspaceId on the
    // identity, independently of provider.kind — a daemon-mode provider
    // paired with a browser-shaped identity (no workspaceId) hits the
    // getAppContextResultSchema cross-field refine instead of silently
    // returning an internally inconsistent result.
    const depsRef = refOf(
      baseDeps({
        provider: {
          kind: 'daemon',
          daemonBaseUrl: 'http://127.0.0.1:9999',
        },
        canvas: { documentId: 'c1', name: 'Canvas 1' },
      }),
    )
    const commands = createWhiteboardCommands(depsRef)

    await expect(commands.getAppContext()).rejects.toMatchObject({
      code: 'invalid-provider-state',
    })
    await expect(commands.getAppContext()).rejects.toBeInstanceOf(CommandError)
  })

  it('excludes secret-bearing fields even given a poisoned ProviderState (simulated future drift)', async () => {
    // Real ProviderState carries no token field today; this cast simulates
    // a future field added to ProviderState leaking through if the
    // projection were ever changed to a spread instead of field-by-field.
    const poisoned = {
      kind: 'daemon',
      daemonBaseUrl: 'http://127.0.0.1:9999',
      token: 'shh',
      authorization: 'Bearer shh',
      secret: 'shh',
    } as unknown as import('../provider.js').ProviderState
    const depsRef = refOf(
      baseDeps({
        provider: poisoned,
        canvas: { workspaceId: 'ws1', documentId: 'c1', name: 'Canvas 1' },
      }),
    )
    const commands = createWhiteboardCommands(depsRef)

    const result = await commands.getAppContext()
    const serialized = JSON.stringify(result).toLowerCase()

    expect(serialized).not.toContain('token')
    expect(serialized).not.toContain('authorization')
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('9999')
  })
})
