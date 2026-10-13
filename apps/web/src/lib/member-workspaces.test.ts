import { describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '../test-utils/json-response.js'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { listMemberWorkspaces } from './member-workspaces.js'

describe('listMemberWorkspaces', () => {
  it('names each workspace by its display name, then its segment, then its id', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        workspaces: [
          { workspaceId: 'w1', segment: 'one', displayName: 'One' },
          { workspaceId: 'w2', segment: 'two' },
          { workspaceId: 'w3' },
        ],
      }),
    )
    await expect(listMemberWorkspaces(fetchFn)).resolves.toEqual([
      { workspaceId: 'w1', segment: 'one', name: 'One' },
      { workspaceId: 'w2', segment: 'two', name: 'two' },
      { workspaceId: 'w3', segment: undefined, name: 'w3' },
    ])
  })

  it('answers unavailable when the keeper is not reached or refuses', async () => {
    const unreached = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const refused = vi.fn(async () => jsonResponse({ error: 'unauthenticated' }, 401))
    await expect(listMemberWorkspaces(unreached)).resolves.toBe('unavailable')
    await expect(listMemberWorkspaces(refused)).resolves.toBe('unavailable')
  })

  it('answers unavailable for a drifted list, and reports the drift', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ workspaces: [{ nope: true }] }))
    await expect(listMemberWorkspaces(fetchFn)).resolves.toBe('unavailable')
    await expectLoggedFailure('/api/workspaces failed its contract')
  })
})
