// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { resolveWorkspaceAddress, workspaceHandle, workspaceLink } from './workspace-handle.js'

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const OTHER_ID = '01BX5ZZKBKACTAV9WEVGEMMVRZ'

describe('workspaceHandle', () => {
  it('qualifies a segment by the namespace holding it', () => {
    expect(workspaceHandle({ workspaceId: ID, namespace: 'ada', segment: 'design' })).toBe(
      'ada/design',
    )
  })

  it("spells a single-person keeper's namespace `me`", () => {
    expect(workspaceHandle({ workspaceId: ID, segment: 'design' })).toBe('me/design')
  })

  it('falls back to the id for a workspace with no segment', () => {
    expect(workspaceHandle({ workspaceId: ID, namespace: 'ada' })).toBe(ID)
  })
})

describe('workspaceLink', () => {
  // ADR-0053 decision 1: a link that may reach someone outside the
  // workspace carries the opaque form, whatever the workspace is called.
  it('is the opaque id form, whatever the workspace is called', () => {
    expect(workspaceLink('https://wb.example', { workspaceId: ID, segment: 'design' })).toBe(
      `https://wb.example/w/${ID}`,
    )
  })
})

describe('resolveWorkspaceAddress', () => {
  const entries = [
    { workspaceId: ID, segment: 'design' },
    { workspaceId: OTHER_ID, namespace: 'ada', segment: 'design' },
  ]

  it('resolves a qualified address inside the namespace it names', () => {
    expect(resolveWorkspaceAddress(entries, 'me/design')?.workspaceId).toBe(ID)
    expect(resolveWorkspaceAddress(entries, 'ada/design')?.workspaceId).toBe(OTHER_ID)
  })

  it('resolves the id form', () => {
    expect(resolveWorkspaceAddress(entries, OTHER_ID)?.workspaceId).toBe(OTHER_ID)
  })

  // An old `/w/<segment>` link: a one-component address is the id form, so a
  // segment alone names nothing (decision 2: break, do not redirect).
  it('never resolves a bare segment', () => {
    expect(resolveWorkspaceAddress(entries, 'design')).toBeNull()
  })

  it('still reaches a legacy non-ULID id by exact match', () => {
    expect(resolveWorkspaceAddress([{ workspaceId: 'default' }], 'default')?.workspaceId).toBe(
      'default',
    )
  })

  it('answers null for an address naming nothing', () => {
    expect(resolveWorkspaceAddress(entries, 'bob/design')).toBeNull()
    expect(resolveWorkspaceAddress(entries, 'not/an/address')).toBeNull()
  })
})
