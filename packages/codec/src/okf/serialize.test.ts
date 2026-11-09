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

  it('writes a value shared between two keys as two copies, which parseOkf reads back', () => {
    const shared = { b: [1, 2] }
    const text = serializeOkf({
      frontmatter: { type: 'note', facetsRaw: { x: shared, y: shared } },
      body: '',
    })
    expect(text).not.toMatch(/[&*]a1/)
    const result = parseOkf(text)
    if (!result.ok) throw new Error(result.error.message)
    expect(result.value.frontmatter.facetsRaw).toEqual({ x: shared, y: shared })
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

describe('serializeOkf and a string the frontmatter subset cannot carry', () => {
  it.each([
    ['a lone surrogate in a value', { facetsRaw: { a: 'x\uD800' } }],
    ['a lone surrogate in a key', { facetsRaw: { 'k\uDC00': 1 } }],
    ['a lone surrogate in the title', { title: '\uD83D' }],
    ['a byte-order mark in a value', { facetsRaw: { a: '\uFEFF' } }],
  ])('refuses %s with the typed error', (_label, extra) => {
    expect(() => serializeOkf({ frontmatter: { type: 'note', ...extra }, body: '' })).toThrow(
      OkfNotYamlSafeError,
    )
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

  // A digit run past 2^53 parses to a rounded neighbour a JSON-shaped store
  // would keep silently. Refusing at the write keeps the author holding the
  // content, where the change would surface on a later read.
  it.each([
    ['an integer past 2^53', 'x: 9007199254740993', ['x']],
    ['an integer past 2^53 nested in a list', 'x: [1, 12345678901234567890]', ['x', 1]],
  ])('refuses %s, naming the key', (_label, line, path) => {
    expect(refusalPaths(frontmatterOf(line))).toEqual([path])
  })

  // The reader refuses a tag before the write is ever reached.
  it.each([
    ['a !!set', 'x: !!set {a, b}'],
    ['an !!omap', 'x: !!omap [a: 1]'],
    ['a !!binary', 'x: !!binary abc'],
  ])('never parses %s, so the store cannot be handed a Set, Map or bytes', (_label, line) => {
    const parsed = parseOkf(frontmatterOf(line))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error.message).toMatch(/tags are not allowed/)
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

describe('a last value ending in blank lines', () => {
  it.each([
    ['a value with two trailing newlines', { a: 'x\n\n' }],
    ['a value of newlines only', { a: '\n\n' }],
    ['one nested under a key past 1024 units', { [' '.repeat(1024)]: { 'a a': '\n\n' } }],
    ['one in a list', { a: ['x', 'y\n\n\n'] }],
  ])('reads back what was written: %s', (_label, facetsRaw) => {
    const text = serializeOkf({ frontmatter: { type: 'note', facetsRaw }, body: 'b' })
    const parsed = parseOkf(text)
    expect(parsed.ok && parsed.value.frontmatter.facetsRaw).toEqual(facetsRaw)
    expect(parsed.ok && parsed.value.body).toBe('b')
  })
})
