// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { displayBranchName } from './utils'

describe('displayBranchName', () => {
  it('capitalizes the literal "main" identifier for display', () => {
    expect(displayBranchName('main')).toBe('Main')
  })

  it('leaves non-main branch names unchanged', () => {
    expect(displayBranchName('feature-x')).toBe('feature-x')
  })

  it('is case-sensitive and does not capitalize case variants of main', () => {
    expect(displayBranchName('Main')).toBe('Main')
    expect(displayBranchName('MAIN')).toBe('MAIN')
  })
})
