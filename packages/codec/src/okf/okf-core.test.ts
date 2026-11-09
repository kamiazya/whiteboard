import { describe, expect, it } from 'vitest'
import type { CodecParseResult } from '../errors.js'
import { type OkfCore, type OkfImpl, type OkfMismatch, okfCodec } from './okf-core.js'
import { parseOkf } from './parse.js'
import type { OkfMarkdownDocument } from './schema.js'
import { OkfNotYamlSafeError, serializeOkf } from './serialize.js'

const TEXT = '---\ntype: note\nweight: 1\n---\nbody\n'
const DOC: OkfMarkdownDocument = { frontmatter: { type: 'note' }, body: 'body\n' }

/** A core that answers as the TypeScript does, with one call replaced. */
function fakeCore(overrides: Partial<OkfCore> = {}): OkfCore & { calls: number } {
  const core = {
    calls: 0,
    parseOkf(text: string) {
      core.calls++
      return (overrides.parseOkf ?? parseOkf)(text)
    },
    serializeOkf(doc: OkfMarkdownDocument) {
      core.calls++
      return (overrides.serializeOkf ?? serializeOkf)(doc)
    },
  }
  return core
}

function switched(okf: OkfCore, impl: OkfImpl) {
  const reports: OkfMismatch[] = []
  const codec = okfCodec({
    okf,
    impl: { parseOkf: impl, serializeOkf: impl },
    onMismatch: (m) => reports.push(m),
  })
  return { codec, reports }
}

const declining = () => {
  throw new Error('declined')
}

describe('okfCodec', () => {
  it('answers with the TypeScript when no core is given', () => {
    const codec = okfCodec(undefined)
    expect(codec.parseOkf(TEXT)).toEqual(parseOkf(TEXT))
    expect(codec.serializeOkf(DOC)).toBe(serializeOkf(DOC))
  })

  it('never asks the core under ts', () => {
    const core = fakeCore()
    const { codec } = switched(core, 'ts')
    codec.parseOkf(TEXT)
    codec.serializeOkf(DOC)
    expect(core.calls).toBe(0)
  })

  it('answers with the core under rust', () => {
    const rustDoc: CodecParseResult<OkfMarkdownDocument> = {
      ok: true,
      value: { frontmatter: { type: 'from-rust' }, body: '' },
    }
    const { codec } = switched(
      fakeCore({ parseOkf: () => rustDoc, serializeOkf: () => 'written by rust' }),
      'rust',
    )
    expect(codec.parseOkf(TEXT)).toBe(rustDoc)
    expect(codec.serializeOkf(DOC)).toBe('written by rust')
  })

  it.each([
    'rust',
    'differential',
  ] as const)('answers a declined call with the TypeScript under %s, and reports it', (impl) => {
    const { codec, reports } = switched(
      fakeCore({ parseOkf: declining, serializeOkf: declining }),
      impl,
    )
    expect(codec.parseOkf(TEXT)).toEqual(parseOkf(TEXT))
    expect(codec.serializeOkf(DOC)).toBe(serializeOkf(DOC))
    expect(reports.map((r) => [r.fn, r.kind])).toEqual([
      ['parseOkf', 'declined'],
      ['serializeOkf', 'declined'],
    ])
  })

  it('reports nothing when the two agree, and answers with the TypeScript', () => {
    const { codec, reports } = switched(fakeCore(), 'differential')
    const ts = parseOkf(TEXT)
    expect(codec.parseOkf(TEXT)).toEqual(ts)
    expect(codec.parseOkf('no fence')).toEqual(parseOkf('no fence'))
    expect(codec.serializeOkf(DOC)).toBe(serializeOkf(DOC))
    expect(reports).toEqual([])
  })

  it('reports a different document and still answers with the TypeScript', () => {
    const { codec, reports } = switched(
      fakeCore({
        parseOkf: (text) => {
          const r = parseOkf(text)
          return r.ok ? { ok: true, value: { ...r.value, body: 'other' } } : r
        },
      }),
      'differential',
    )
    expect(codec.parseOkf(TEXT)).toEqual(parseOkf(TEXT))
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ fn: 'parseOkf', kind: 'differs', text: TEXT })
  })

  it('tells -0 from 0 and a number from a bigint', () => {
    for (const other of [-0, 1n]) {
      const { codec, reports } = switched(
        fakeCore({
          parseOkf: (text) => {
            const r = parseOkf(text)
            if (!r.ok) return r
            const frontmatter = { ...r.value.frontmatter, facetsRaw: { weight: other } }
            return { ok: true, value: { ...r.value, frontmatter } }
          },
        }),
        'differential',
      )
      const text = '---\ntype: note\nweight: 0\n---\n'
      expect(parseOkf(text)).toMatchObject({ value: { frontmatter: { facetsRaw: { weight: 0 } } } })
      codec.parseOkf(text)
      expect(
        reports.map((r) => r.kind),
        String(other),
      ).toEqual(['differs'])
    }
  })

  it('tells two key orders apart', () => {
    const { codec, reports } = switched(
      fakeCore({
        parseOkf: () => ({
          ok: true,
          value: { frontmatter: { title: 't', type: 'note' }, body: '' },
        }),
      }),
      'differential',
    )
    codec.parseOkf('---\ntype: note\ntitle: t\n---\n')
    expect(reports.map((r) => r.kind)).toEqual(['differs'])
  })

  it('compares a refusal by stage and issue path and code, and a YAML one without its words', () => {
    const yaml = '---\ntype: [\n---\n'
    const schema = '---\ntype: 1\n---\n'
    const reworded = (text: string): CodecParseResult<OkfMarkdownDocument> => {
      const r = parseOkf(text)
      if (r.ok) return r
      return {
        ok: false,
        error: {
          ...r.error,
          message: r.error.stage === 'yaml' ? 'other words' : r.error.message,
          issues: r.error.issues.map((i) => ({ code: i.code, path: i.path, message: 'x' })),
        },
      }
    }
    const agree = switched(fakeCore({ parseOkf: reworded }), 'differential')
    expect(agree.codec.parseOkf(yaml)).toEqual(parseOkf(yaml))
    agree.codec.parseOkf(schema)
    expect(agree.reports).toEqual([])

    const moved = switched(
      fakeCore({
        parseOkf: (text) => {
          const r = parseOkf(text)
          if (r.ok) return r
          return {
            ok: false,
            error: {
              ...r.error,
              issues: r.error.issues.map((i) => ({ ...i, path: ['elsewhere'] })),
            },
          }
        },
      }),
      'differential',
    )
    moved.codec.parseOkf(schema)
    expect(moved.reports.map((r) => r.kind)).toEqual(['differs'])
  })

  it('reports a different text from the writer', () => {
    const { codec, reports } = switched(
      fakeCore({ serializeOkf: (doc) => `${serializeOkf(doc)}extra` }),
      'differential',
    )
    expect(codec.serializeOkf(DOC)).toBe(serializeOkf(DOC))
    expect(reports).toMatchObject([{ fn: 'serializeOkf', kind: 'differs', doc: DOC }])
  })

  it('throws the TypeScript writer refusal when the core declines it too', () => {
    const unsafe: OkfMarkdownDocument = {
      frontmatter: { type: 'note', facetsRaw: { n: Number.NaN } },
      body: '',
    }
    for (const impl of ['rust', 'differential'] as const) {
      const { codec } = switched(fakeCore({ serializeOkf: declining }), impl)
      expect(() => codec.serializeOkf(unsafe)).toThrow(OkfNotYamlSafeError)
    }
  })

  it('reports a core that writes what the TypeScript refuses', () => {
    const unsafe: OkfMarkdownDocument = {
      frontmatter: { type: 'note', facetsRaw: { n: Number.NaN } },
      body: '',
    }
    const { codec, reports } = switched(fakeCore({ serializeOkf: () => 'written' }), 'differential')
    expect(() => codec.serializeOkf(unsafe)).toThrow(OkfNotYamlSafeError)
    expect(reports.map((r) => r.kind)).toEqual(['differs'])
  })
})
