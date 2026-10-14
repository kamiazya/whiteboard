// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createWhiteboardCommands } from './create-commands.js'
import { CommandError, type WhiteboardCommandDeps } from './types.js'

const IDENTITY = { workspaceId: 'ws1', documentId: 'c1', path: 'notes/plan.md' }

function baseDeps(overrides: Partial<WhiteboardCommandDeps> = {}): WhiteboardCommandDeps {
  return {
    provider: { kind: 'browser' },
    canvas: IDENTITY,
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
      canvas: { workspaceId: 'ws1', documentId: 'c1', path: 'notes/plan.md' },
    })
  })

  it('projects a daemon provider field-by-field, excluding daemonBaseUrl even though ProviderState carries one', async () => {
    const depsRef = refOf(
      baseDeps({
        provider: {
          kind: 'daemon',
          daemonBaseUrl: 'http://127.0.0.1:9999',
        },
      }),
    )
    const commands = createWhiteboardCommands(depsRef)

    const result = await commands.getAppContext()

    expect(result).toEqual({
      provider: { mode: 'daemon' },
      canvas: { workspaceId: 'ws1', documentId: 'c1', path: 'notes/plan.md' },
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

  it('takes the keeper from the provider alone, answering one identity shape for both', async () => {
    const browser = await createWhiteboardCommands(refOf(baseDeps())).getAppContext()
    const daemon = await createWhiteboardCommands(
      refOf(baseDeps({ provider: { kind: 'daemon', daemonBaseUrl: 'http://127.0.0.1:9999' } })),
    ).getAppContext()

    expect(browser.provider.mode).toBe('browser')
    expect(daemon.provider.mode).toBe('daemon')
    expect(daemon.canvas).toEqual(browser.canvas)
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
