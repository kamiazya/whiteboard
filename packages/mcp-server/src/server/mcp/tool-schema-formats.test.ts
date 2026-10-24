import { describe, expect, it } from 'vitest'
import { connectDocumentTools as connect } from './_test-document-tools-client.js'

describe('the tool listing', () => {
  // A client may validate a tool's schema with a strict JSON Schema validator,
  // which refuses a `format` the specification does not define. zod emits
  // vendor formats for some checks (`.startsWith` became `"starts_with"` in
  // 4.6), so this holds the whole listing to the 2020-12 vocabulary.
  it('every tool schema names only formats JSON Schema 2020-12 defines', async () => {
    const standard = new Set([
      'date-time',
      'date',
      'time',
      'duration',
      'email',
      'idn-email',
      'hostname',
      'idn-hostname',
      'ipv4',
      'ipv6',
      'uri',
      'uri-reference',
      'iri',
      'iri-reference',
      'uuid',
      'uri-template',
      'json-pointer',
      'relative-json-pointer',
      'regex',
    ])
    const formatsIn = (node: unknown, at: string, into: string[]): string[] => {
      if (Array.isArray(node)) {
        for (const [i, each] of node.entries()) formatsIn(each, `${at}[${i}]`, into)
      } else if (node !== null && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (key === 'format' && typeof value === 'string') into.push(`${at}: ${value}`)
          else formatsIn(value, `${at}.${key}`, into)
        }
      }
      return into
    }
    const { tools } = await connect()
    const seen = tools.flatMap((tool) =>
      formatsIn({ input: tool.inputSchema, output: tool.outputSchema }, tool.name, []),
    )
    expect(seen.length, 'the listing names some format, so the walk reaches one').toBeGreaterThan(0)
    expect(seen.filter((entry) => !standard.has(entry.slice(entry.lastIndexOf(': ') + 2)))).toEqual(
      [],
    )
  })
})
