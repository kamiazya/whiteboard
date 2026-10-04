import { describe, expect, it } from 'vitest'
import { parseOkf } from './parse.js'
import { OkfNotYamlSafeError, serializeOkf } from './serialize.js'

describe('serializeOkf', () => {
  it('emits facets-domain keys in canonical lexicographic order regardless of authoring order', () => {
    const text = serializeOkf({
      frontmatter: {
        type: 'note',
        facets: {
          'zeta.z/v1': { z: 1 },
          'alpha.a/v2': { a: 1 },
          'mu.m/v1': { m: 1 },
        },
      },
      body: 'hello',
    })

    const facetsBlock = text.slice(text.indexOf('facets:'), text.indexOf('body:') || undefined)
    const firstKeyIndex = ['alpha.a/v2', 'mu.m/v1', 'zeta.z/v1']
      .map((key) => facetsBlock.indexOf(key))
      .filter((index) => index !== -1)
    expect(firstKeyIndex).toEqual([...firstKeyIndex].sort((a, b) => a - b))
    expect(facetsBlock.indexOf('alpha.a/v2')).toBeLessThan(facetsBlock.indexOf('mu.m/v1'))
    expect(facetsBlock.indexOf('mu.m/v1')).toBeLessThan(facetsBlock.indexOf('zeta.z/v1'))
  })

  it('round-trips a minimal document through parseOkf', () => {
    const text = serializeOkf({ frontmatter: { type: 'note', title: 'Hi' }, body: 'body text' })
    const result = parseOkf(text)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    expect(result.value.frontmatter.type).toBe('note')
    expect(result.value.frontmatter.title).toBe('Hi')
    expect(result.value.body).toBe('body text')
  })

  it('keeps a last value that ends in a Unicode space, which JS trimEnd() would take', () => {
    // U+2000 and U+00A0 are whitespace to `String.prototype.trimEnd` and
    // printable characters to YAML, so yaml writes them bare at the end of
    // the last line; a trimEnd() over the whole text then left `view:` with
    // nothing after it, and parseOkf read the value back as null. Found by
    // the round-trip property (seed -1838762366).
    for (const view of ['\u2000', 'x\u00a0']) {
      const text = serializeOkf({ frontmatter: { type: 'note', view }, body: '' })
      const result = parseOkf(text)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.frontmatter.view).toBe(view)
    }
  })

  it('throws a typed error naming the key when a facet value is not yaml-safe', () => {
    let thrown: unknown
    try {
      serializeOkf({
        frontmatter: { type: 'note', facets: { 'x.y/v1': { bad: Number.NaN } } },
        body: '',
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(OkfNotYamlSafeError)
    expect((thrown as OkfNotYamlSafeError).issues).toMatchObject([
      { path: ['facets', 'x.y/v1', 'bad'], message: 'NaN is not yaml-safe' },
    ])
    expect((thrown as Error).message).toMatch(/yaml-safe/)
  })
})

describe('OkfNotYamlSafeError', () => {
  // The message is what a caller logs or relays, and the name is how it is told from a serialiser defect.
  function thrownBy(): OkfNotYamlSafeError {
    try {
      serializeOkf({
        frontmatter: {
          type: 'note',
          facets: { 'x.y/v1': { bad: Number.NaN, worse: Number.POSITIVE_INFINITY } },
        },
        body: '',
      })
    } catch (error) {
      return error as OkfNotYamlSafeError
    }
    throw new Error('serializeOkf did not throw')
  }

  it('names every offending key path in its message, joined by "; "', () => {
    const { message } = thrownBy()
    expect(message).toContain('facets.x.y/v1.bad: NaN is not yaml-safe')
    expect(message).toMatch(/facets\.x\.y\/v1\.bad: [^;]+; facets\.x\.y\/v1\.worse: /)
  })

  it('carries its own name, so a caller reading err.name can tell it from a serialiser defect', () => {
    expect(thrownBy().name).toBe('OkfNotYamlSafeError')
  })
})

describe('a preserved root key that YAML parses into something the store cannot hold', () => {
  const frontmatterOf = (line: string) => `---\ntype: note\n${line}\n---\nbody`
  const refusalPaths = (text: string): unknown => {
    const parsed = parseOkf(text)
    if (!parsed.ok) throw new Error('fixture must parse')
    try {
      serializeOkf(parsed.value)
    } catch (error) {
      if (error instanceof OkfNotYamlSafeError) return error.issues.map((issue) => issue.path)
      throw error
    }
    return null
  }

  // Each of these parses to a value a JSON-shaped store flattens: a Set and a
  // Map to `{}`, bytes to an array of numbers, a digit run past 2^53 to its
  // rounded neighbour. Refusing at the write keeps the author holding the
  // content, where a silent normalisation would surface on a later read.
  it.each([
    ['a !!set', 'x: !!set {a, b}', ['x']],
    ['an !!omap', 'x: !!omap [a: 1]', ['x']],
    ['a !!binary', 'x: !!binary abc', ['x']],
    ['an integer past 2^53', 'x: 9007199254740993', ['x']],
    ['an integer past 2^53 nested in a list', 'x: [1, 12345678901234567890]', ['x', 1]],
  ])('refuses %s, naming the key', (_label, line, path) => {
    expect(refusalPaths(frontmatterOf(line))).toEqual([path])
  })

  // Value-preserving: the same number, spelled the way YAML 1.2's core
  // schema reads it. The write succeeds and the key reads back as 16.
  it.each([
    ['a hexadecimal integer', 'x: 0x10', 'x: 16'],
    ['an octal integer', 'x: 0o17', 'x: 15'],
    ['an exponent', 'x: 1e3', 'x: 1000'],
    ['a float with no fraction', 'x: 1.0', 'x: 1'],
  ])('normalises %s to its decimal value rather than refusing it', (_label, line, expected) => {
    const parsed = parseOkf(frontmatterOf(line))
    if (!parsed.ok) throw new Error('fixture must parse')
    expect(serializeOkf(parsed.value)).toContain(`\n${expected}\n`)
  })

  it('keeps a large integer that is the digits JS prints for its double, which is what serializeOkf writes', () => {
    expect(refusalPaths(frontmatterOf('x: 38452588508904010'))).toBeNull()
  })

  it('keeps a safe integer at the boundary', () => {
    expect(refusalPaths(frontmatterOf('x: 9007199254740991'))).toBeNull()
  })
})

describe('serializeOkf spreads facetsRaw back at the root (OKF §4.1)', () => {
  it('emits preserved keys as root frontmatter, never as a nested `facetsRaw:` key', () => {
    const text = serializeOkf({
      frontmatter: {
        type: 'Metric',
        title: 'Revenue',
        facetsRaw: { status: 'stable', description: 'one line' },
      },
      body: 'body',
    })

    expect(text).toContain('\nstatus: stable\n')
    expect(text).toContain('\ndescription: one line\n')
    expect(text).not.toContain('facetsRaw:')
  })

  it('emits preserved keys in canonical lexicographic order', () => {
    const text = serializeOkf({
      frontmatter: { type: 'note', facetsRaw: { zeta: 1, alpha: 2, mu: 3 } },
      body: '',
    })

    expect(text.indexOf('alpha:')).toBeLessThan(text.indexOf('mu:'))
    expect(text.indexOf('mu:')).toBeLessThan(text.indexOf('zeta:'))
  })

  it('rejects a preserved value that is not yaml-safe, like any other frontmatter value', () => {
    expect(() =>
      serializeOkf({ frontmatter: { type: 'note', facetsRaw: { bad: Number.NaN } }, body: '' }),
    ).toThrow(/yaml-safe/)
  })
})
