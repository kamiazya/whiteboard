import { describe, expect, it } from 'vitest'
import { HOSTED_APP_ORIGIN } from './hosted-app.js'

describe('HOSTED_APP_ORIGIN', () => {
  // The extension admits this page, the daemon opens it and the web app calls
  // it production, each deriving its own shape from this one value. A change
  // here moves all three; this is where the deployed address is decided.
  it('is the provisional pages.dev deployment', () => {
    expect(HOSTED_APP_ORIGIN).toBe('https://kamiazya-whiteboard.pages.dev')
  })

  // Consumers append `/` and `/*` to it, so a trailing slash or a path would
  // make a match pattern no browser accepts.
  it('is a bare https origin', () => {
    const url = new URL(HOSTED_APP_ORIGIN)
    expect(url.protocol).toBe('https:')
    expect(url.origin).toBe(HOSTED_APP_ORIGIN)
  })
})
