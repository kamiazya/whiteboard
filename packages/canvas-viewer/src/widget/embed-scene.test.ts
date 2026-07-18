import { describe, expect, it } from 'vitest'
import { serializeSceneForScriptTag } from './embed-scene.js'

describe('serializeSceneForScriptTag', () => {
  it('serializes a plain scene the same as JSON.stringify', () => {
    const scene = { elements: [], appState: {}, files: {} }
    expect(serializeSceneForScriptTag(scene)).toBe(JSON.stringify(scene))
  })

  it('escapes a </script> breakout attempt inside scene text so no literal closing tag survives', () => {
    const scene = { elements: [{ text: '</script><script>alert(1)</script>' }] }
    const serialized = serializeSceneForScriptTag(scene)

    expect(serialized).not.toContain('</script>')
    expect(serialized).not.toContain('<script>')
    expect(JSON.parse(serialized)).toEqual(scene)
  })

  it('escapes an SGML comment opener the same way', () => {
    const scene = { elements: [{ text: '<!--' }] }
    const serialized = serializeSceneForScriptTag(scene)

    expect(serialized).not.toContain('<!--')
    expect(JSON.parse(serialized)).toEqual(scene)
  })
})
