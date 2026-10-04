import { describe, expect, it } from 'vitest'
import { createFailureCopy } from './workspace-create-failure.js'

describe('createFailureCopy', () => {
  it('names a session with no person when the keeper refused for that code', () => {
    const copy = createFailureCopy({
      status: 403,
      body: { error: 'requires_person_session', message: 'no person' },
    })
    expect(copy).toMatch(/not signed in as a person/i)
    expect(copy).toMatch(/nothing was created/i)
  })

  it('reads the code, not the keeper’s sentence', () => {
    const copy = createFailureCopy({
      status: 403,
      body: { error: 'requires_person_session', message: 'reworded by the keeper' },
    })
    expect(copy).not.toContain('reworded')
    expect(copy).toMatch(/not signed in as a person/i)
  })

  it('does not take a different refusal for that one', () => {
    const cause = { status: 403, body: { error: 'not_a_member', message: 'not yours' } }
    expect(createFailureCopy(cause)).not.toMatch(/not signed in as a person/i)
  })

  it('does not take the code on a non-403 for that refusal', () => {
    const cause = { status: 500, body: { error: 'requires_person_session', message: 'no person' } }
    expect(createFailureCopy(cause)).not.toMatch(/not signed in as a person/i)
  })

  it('shows an Error’s own message, and a generic sentence for anything else', () => {
    expect(createFailureCopy(new Error('that name is taken'))).toBe('that name is taken')
    expect(createFailureCopy(undefined)).toMatch(
      /could not create the workspace.*nothing was created/i,
    )
  })
})
