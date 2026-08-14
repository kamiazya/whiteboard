import { describe, expect, it } from 'vitest'
import { requiresDaemonAuth } from './auth.js'

describe('requiresDaemonAuth', () => {
  it('default-requires bearer auth for every /api method, not just mutations', () => {
    expect(requiresDaemonAuth('/api/workspaces/session-1/canvases')).toBe(true)
    expect(requiresDaemonAuth('/api/brand-new-mutation')).toBe(true)
    // Canvas/asset reads are covered too: ADR-0002's read carve-out assumed a
    // hosted origin could never reach the daemon, which ADR-0005 retires. The
    // client already sends the bearer on every read (apiFetch, and every image
    // consumer fetches+blobs instead of using a bare <img src>), so requiring
    // it server-side costs nothing on the happy path and closes the
    // read-without-a-token surface for anyone else.
    expect(requiresDaemonAuth('/api/workspaces')).toBe(true)
    expect(requiresDaemonAuth('/api/canvas/session-1/demo/snapshot')).toBe(true)
    expect(
      requiresDaemonAuth('/api/workspaces/session-1/canvases/demo/versions/v1/thumbnail'),
    ).toBe(true)
    expect(requiresDaemonAuth('/api/canvas/session-1/demo/file/f1')).toBe(true)
  })

  it('allows only /api/runtime/ping to bypass the middleware', () => {
    expect(requiresDaemonAuth('/api/runtime/ping')).toBe(false)
    expect(requiresDaemonAuth('/api/runtime/status')).toBe(true)
    expect(requiresDaemonAuth('/api/runtime/touch')).toBe(true)
    expect(requiresDaemonAuth('/api/runtime/shutdown')).toBe(true)
    expect(requiresDaemonAuth('/api/runtime/brand-new')).toBe(true)
  })

  it('leaves non-/api paths alone', () => {
    expect(requiresDaemonAuth('/canvas/session-1/demo')).toBe(false)
    expect(requiresDaemonAuth('/')).toBe(false)
  })
})
