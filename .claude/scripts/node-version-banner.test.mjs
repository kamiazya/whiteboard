import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { pinnedMajor, wrongNodeBanner } from './node-version-banner.mjs'

describe('the wrong-Node-major banner', () => {
  it('is silent on the pinned major', () => {
    assert.equal(wrongNodeBanner({ pinned: '24', versions: { node: '24.3.0', unicode: '17.0' } }), null)
  })

  it('is silent when the pin is unreadable', () => {
    assert.equal(wrongNodeBanner({ pinned: undefined, versions: { node: '22.1.0', unicode: '16.0' } }), null)
  })

  it('names the pin, the running version, Unicode, both symptom families and the guard', () => {
    const banner = wrongNodeBanner({ pinned: '24', versions: { node: '22.22.0', unicode: '16.0' } })
    assert.ok(banner)
    for (const part of [
      '22.22.0',
      '16.0',
      '.node-version pins 24',
      'object.stream is not a function',
      'honours a Prepend',
      'local-node-version.test.ts',
    ]) {
      assert.ok(banner.includes(part), `banner lacks ${part}`)
    }
  })

  it('reads the leading number of a pin however it is written', () => {
    assert.equal(pinnedMajor('24\n'), '24')
    assert.equal(pinnedMajor('v24.1.0'), '24')
    assert.equal(pinnedMajor('lts'), undefined)
  })
})
