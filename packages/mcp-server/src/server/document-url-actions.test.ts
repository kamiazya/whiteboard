// The URL builder's action union is a promise that a route answers it. Types
// cannot see the daemon's registrations, so a deleted route leaves its action
// compiling and every caller of it getting a 404.
import { DOCUMENT_API_ACTIONS } from '@kamiazya/whiteboard-daemon-client/api-contracts/document-url'
import { describe, expect, it } from 'vitest'
import { registeredKeys } from './_test-route-fuzz-lane.js'

const DOCUMENT_ACTION_KEY = /^[A-Z]+ \/api\/w\/:workspaceId\/document\/\*\/([\w-]+)$/

describe('documentApiUrl actions', () => {
  // Wildcard actions are read off the registration calls, so no app is needed.
  const registeredActions = new Set(
    registeredKeys({ routes: [] }).flatMap((key) => {
      const action = DOCUMENT_ACTION_KEY.exec(key)?.[1]
      return action === undefined ? [] : [action]
    }),
  )

  it('finds the registered document actions at all', () => {
    expect(registeredActions.size).toBeGreaterThan(3)
  })

  it.each(DOCUMENT_API_ACTIONS)('has a registered route behind %s', (action) => {
    expect(registeredActions.has(action)).toBe(true)
  })
})
