import { describe, expect, it } from 'vitest'
import { serializeForScriptTag } from './embed-picture.js'

describe('serializeForScriptTag', () => {
  it('serializes a plain picture the same as JSON.stringify', () => {
    const picture = { svg: '', boxes: [] }
    expect(serializeForScriptTag(picture)).toBe(JSON.stringify(picture))
  })

  it('escapes a </script> breakout attempt inside picture text so no literal closing tag survives', () => {
    const picture = { svg: '<text></script><script>alert(1)</script></text>', boxes: [] }
    const serialized = serializeForScriptTag(picture)

    expect(serialized).not.toContain('</script>')
    expect(serialized).not.toContain('<script>')
    expect(JSON.parse(serialized)).toEqual(picture)
  })

  it('escapes an SGML comment opener the same way', () => {
    const picture = { svg: '<!--', boxes: [] }
    const serialized = serializeForScriptTag(picture)

    expect(serialized).not.toContain('<!--')
    expect(JSON.parse(serialized)).toEqual(picture)
  })
})
