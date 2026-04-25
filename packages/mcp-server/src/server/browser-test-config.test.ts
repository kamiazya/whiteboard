import { describe, expect, it } from 'vitest'

const { resolveBrowserLaunchOptions } = await import('./browser-test-config.js')

describe('resolveBrowserLaunchOptions', () => {
  it('defaults to Playwright-managed browsers when no override is provided', () => {
    expect(resolveBrowserLaunchOptions({})).toEqual({})
  })

  it('uses WHITEBOARD_CHROME_PATH when explicitly provided', () => {
    expect(
      resolveBrowserLaunchOptions({
        WHITEBOARD_CHROME_PATH: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      }),
    ).toEqual({
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    })
  })

  it('ignores blank WHITEBOARD_CHROME_PATH values', () => {
    expect(
      resolveBrowserLaunchOptions({
        WHITEBOARD_CHROME_PATH: '   ',
      }),
    ).toEqual({})
  })
})
