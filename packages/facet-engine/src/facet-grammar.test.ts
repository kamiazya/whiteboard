import { EXTENSION_FACET_KEY_PATTERN, TAG_IDENTIFIER_PATTERN } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import {
  FACET_KEY_PATTERN,
  FACET_NAMESPACED_ID_PATTERN,
  FACET_SEGMENT_PATTERN,
} from './facet-grammar.js'

// model and facet-engine cannot import each other, so each owns a copy of the
// grammar; this is the only place both are visible and compared.
describe('the engine and model spell one facet key grammar', () => {
  it('the key pattern is the same expression as model’s stored-key pattern', () => {
    expect(FACET_KEY_PATTERN.source).toBe(EXTENSION_FACET_KEY_PATTERN.source)
    expect(FACET_KEY_PATTERN.flags).toBe(EXTENSION_FACET_KEY_PATTERN.flags)
  })

  it('the segment pattern is the same expression as model’s tag half', () => {
    expect(FACET_SEGMENT_PATTERN.source).toBe(TAG_IDENTIFIER_PATTERN.source)
    expect(FACET_SEGMENT_PATTERN.flags).toBe(TAG_IDENTIFIER_PATTERN.flags)
  })

  it('the namespaced id is the key without its version', () => {
    expect(FACET_NAMESPACED_ID_PATTERN.source).toBe(
      FACET_KEY_PATTERN.source.replace('\\/v[0-9]+$', '$'),
    )
  })

  it('agrees with model on a table of keys either side of every boundary', () => {
    const keys = [
      'visual.shape/v0',
      'a.b/v12',
      'my-plugin.my-facet/v1',
      'visual.shape',
      'visual.shape/v',
      'visual.shape/1',
      'Visual.shape/v0',
      '1visual.shape/v0',
      'visual_x.shape/v0',
      'visual.sh ape/v0',
      'visual.shape/v0\n',
      '.shape/v0',
      'visual./v0',
      '',
    ]
    for (const key of keys) {
      expect(FACET_KEY_PATTERN.test(key), key).toBe(EXTENSION_FACET_KEY_PATTERN.test(key))
    }
    expect(keys.filter((k) => FACET_KEY_PATTERN.test(k))).toHaveLength(3)
  })
})
