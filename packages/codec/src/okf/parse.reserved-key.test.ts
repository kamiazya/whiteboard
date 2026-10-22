import { describe, expect, it } from 'vitest'
import { parseYamlKeepingWrittenIntegers } from './frontmatter-yaml.js'
import { parseOkf } from './parse.js'

/**
 * YAML defines a `__proto__` mapping key as an OWN property, and a stored
 * record holding one comes back from every JSON projection with its
 * prototype replaced — which no later read of the document can serialise.
 */
describe('parseOkf refuses a key named __proto__', () => {
  it.each([
    ['nested under an unknown root key', 'x:\n  __proto__:\n    a: 1'],
    ['at the root', '__proto__:\n  a: 1'],
    ['inside an extension facet', 'facets:\n  acme.x/v0:\n    __proto__:\n      a: 1'],
    ['inside a list item', 'x:\n  - __proto__: 1'],
  ])('%s, at the frontmatter-schema stage', (_label, yaml) => {
    const result = parseOkf(`---\ntype: note\n${yaml}\n---\nbody\n`)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.stage).toBe('frontmatter-schema')
    expect(result.error.message).toContain('__proto__')
  })

  it('still parses a value that only NAMES the key', () => {
    const result = parseOkf('---\ntype: note\nx: __proto__\n---\nbody\n')
    expect(result.ok).toBe(true)
  })
})

describe('frontmatter YAML is read as YAML 1.2 core whatever it declares', () => {
  it('does not merge a << key, nor read yes as a boolean, under a %YAML 1.1 directive', () => {
    // `parseOkf`'s block pattern leaves no room for a directive today; this
    // pins the reader itself so a looser pattern cannot reopen 1.1's rules.
    const value = parseYamlKeepingWrittenIntegers('%YAML 1.1\n---\nx:\n  <<: { a: 1 }\ny: yes\n')
    expect(value).toEqual({ x: { '<<': { a: 1 } }, y: 'yes' })
  })
})
