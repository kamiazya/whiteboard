// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { queryLocalNetworkPermission } from './local-network-permission.js'

// A Permissions stand-in that recognizes only the names it was built with,
// mirroring how a real engine rejects an unknown descriptor with a TypeError
// rather than resolving to some neutral state.
function permissionsKnowing(known: Record<string, PermissionState>): Permissions {
  return {
    query: vi.fn(async (descriptor: { name: string }) => {
      const state = known[descriptor.name]
      if (state === undefined) {
        throw new TypeError(`Unrecognized permission name: ${descriptor.name}`)
      }
      return { state } as PermissionStatus
    }),
  } as unknown as Permissions
}

describe('queryLocalNetworkPermission', () => {
  it('reports unknown when the engine has no Permissions API', async () => {
    // Safari and Firefox never prompt for local network access, so there is
    // nothing to read. 'unknown' keeps callers on the pre-existing path
    // instead of inventing a state the browser never had.
    await expect(queryLocalNetworkPermission(undefined)).resolves.toBe('unknown')
  })

  it.each([
    'granted',
    'prompt',
    'denied',
  ] as const)('passes through the %s state of the loopback-network permission', async (state) => {
    const permissions = permissionsKnowing({ 'loopback-network': state })
    await expect(queryLocalNetworkPermission(permissions)).resolves.toBe(state)
  })

  it('asks for loopback-network, not the broader local-network', async () => {
    // The daemon lives on 127.0.0.1, which the spec scopes to the narrower
    // 'loopback-network' feature. Querying 'local-network' would read a
    // permission the connection does not actually need.
    const permissions = permissionsKnowing({
      'loopback-network': 'granted',
      'local-network': 'denied',
    })
    await expect(queryLocalNetworkPermission(permissions)).resolves.toBe('granted')
  })

  it('falls back to the Chromium alias when the spec name is unrecognized', async () => {
    // Chromium shipped the coarse 'local-network-access' name before the
    // spec split it in two, so a browser that prompts but predates the split
    // must still be readable.
    const permissions = permissionsKnowing({ 'local-network-access': 'denied' })
    await expect(queryLocalNetworkPermission(permissions)).resolves.toBe('denied')
  })

  it('reports unknown when no name is recognized', async () => {
    await expect(queryLocalNetworkPermission(permissionsKnowing({}))).resolves.toBe('unknown')
  })

  it('stops asking when the rejection is not about an unrecognized name', async () => {
    // Only an unrecognized descriptor (TypeError) says anything about which
    // name this engine understands. A permissions-policy denial rejects with
    // a NotAllowedError and would reject the alias identically, so retrying
    // it is a second pointless call — and the answer stays 'unknown' either
    // way, which is why the call count is what pins the behavior.
    const query = vi.fn(async () => {
      throw new DOMException('denied by permissions policy', 'NotAllowedError')
    })
    const permissions = { query } as unknown as Permissions

    await expect(queryLocalNetworkPermission(permissions)).resolves.toBe('unknown')
    expect(query).toHaveBeenCalledTimes(1)
  })
})
