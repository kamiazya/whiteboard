import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { installOkfCoreForTests } from '../test-utils/okf-core-setup/install.js'
import {
  installOkfCore,
  OkfNotYamlSafeError,
  okfCoreInstalled,
  parseOkf,
  serializeOkf,
} from './okf-core.js'
import type { OkfMarkdownDocument } from './schema.js'

const DOC: OkfMarkdownDocument = { frontmatter: { type: 'note' }, body: 'body\n' }
const TEXT = '---\ntype: note\n---\nbody\n'

const named = (name: string, extra: object = {}): Error =>
  Object.assign(new Error(`${name} thrown by the core`), { name }, extra)

/** A core whose every call throws `err`, standing for what the shim throws. */
const throwing = (err: Error) => ({
  parseOkf: () => {
    throw err
  },
  serializeOkf: () => {
    throw err
  },
})

describe('a realm with no core installed', () => {
  // The installation is process-global; the setup file's core is back for the next test.
  afterEach(() => installOkfCoreForTests())

  it('refuses to read, and says what to do, rather than answering', () => {
    installOkfCore(undefined)
    expect(okfCoreInstalled()).toBe(false)
    expect(() => parseOkf(TEXT)).toThrow(/before this realm installed the Rust core/)
    expect(() => parseOkf(TEXT)).toThrow(/installOkfCore/)
  })

  it('refuses to write', () => {
    installOkfCore(undefined)
    expect(() => serializeOkf(DOC)).toThrow(/before this realm installed the Rust core/)
  })
})

describe('the realm core', () => {
  beforeAll(() => installOkfCoreForTests())
  afterEach(() => installOkfCoreForTests())

  it('answers the plain exports through the installed core', () => {
    const answer = { ok: true as const, value: { frontmatter: { type: 'from-core' }, body: '' } }
    installOkfCore({ parseOkf: () => answer, serializeOkf: () => 'from core' })
    expect(parseOkf('anything')).toBe(answer)
    expect(serializeOkf(DOC)).toBe('from core')
  })

  it('reads and writes through the staged Rust core', () => {
    expect(okfCoreInstalled()).toBe(true)
    const read = parseOkf(TEXT)
    expect(read).toEqual({ ok: true, value: { frontmatter: { type: 'note' }, body: 'body\n' } })
    expect(serializeOkf(DOC)).toBe(TEXT)
  })

  it('reports a text the core declines as a refusal at the schema stage, with the core reason', () => {
    installOkfCore(throwing(named('CoreInputRefused')))
    const read = parseOkf(TEXT)
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.error.stage).toBe('frontmatter-schema')
    expect(read.error.message).toMatch(/refused this document: CoreInputRefused thrown by the core/)
  })

  it('throws the typed write refusal for a document the core declines', () => {
    installOkfCore(throwing(named('CoreInputRefused')))
    const thrown = (() => {
      try {
        serializeOkf(DOC)
      } catch (err) {
        return err
      }
    })()
    expect(thrown).toBeInstanceOf(OkfNotYamlSafeError)
    expect((thrown as OkfNotYamlSafeError).issues).toEqual([
      { path: [], message: expect.stringContaining('refused this document') },
    ])
  })

  it('throws the typed write refusal, with the places, for a value the core says has no YAML spelling', () => {
    const issues = [{ path: ['title'], message: 'a number with no YAML spelling' }]
    installOkfCore(throwing(named('CoreOkfUnwritable', { issues })))
    expect(() => serializeOkf(DOC)).toThrow(OkfNotYamlSafeError)
    try {
      serializeOkf(DOC)
    } catch (err) {
      expect((err as OkfNotYamlSafeError).issues).toEqual(issues)
    }
  })

  it('keeps an unrecognised throw loud, for a read and a write', () => {
    installOkfCore(throwing(new RangeError('a defect')))
    expect(() => parseOkf(TEXT)).toThrow(RangeError)
    expect(() => serializeOkf(DOC)).toThrow(RangeError)
  })

  it('does not take an unwritable answer with malformed places for the typed refusal', () => {
    installOkfCore(throwing(named('CoreOkfUnwritable', { issues: [{ path: 'title' }] })))
    expect(() => serializeOkf(DOC)).toThrow(/thrown by the core/)
    expect(() => serializeOkf(DOC)).not.toThrow(OkfNotYamlSafeError)
  })
})
