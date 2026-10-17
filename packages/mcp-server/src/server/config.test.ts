import { describe, expect, it } from 'vitest'
import { resolveDataDir } from './config.js'

describe('resolveDataDir', () => {
  it('prefers WHITEBOARD_DATA_DIR above all other candidates', () => {
    expect(
      resolveDataDir(
        {
          WHITEBOARD_DATA_DIR: '/custom/whiteboard',
        },
        {
          isWritableDir: () => false,
        },
      ),
    ).toBe('/custom/whiteboard')
  })

  it('uses the writable home candidate when there is no env override', () => {
    expect(
      resolveDataDir(
        {},
        {
          homeDir: '/home/demo',
          tmpDir: '/tmp/demo',
          isWritableDir: (path) => path === '/home/demo/.whiteboard',
        },
      ),
    ).toBe('/home/demo/.whiteboard')
  })

  it('falls back to tmp when the home candidate is not writable', () => {
    expect(
      resolveDataDir(
        {},
        {
          homeDir: '/home/demo',
          tmpDir: '/tmp/demo',
          isWritableDir: () => false,
        },
      ),
    ).toBe(
      // The fallback is per user wherever there is a uid, so another user
      // cannot prepare it first.
      process.getuid === undefined
        ? '/tmp/demo/.whiteboard'
        : `/tmp/demo/.whiteboard-${process.getuid()}`,
    )
  })
})
