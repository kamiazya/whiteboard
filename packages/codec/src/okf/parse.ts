import { normalizeOkfVerified, RESERVED_ROOT_KEYS } from '@kamiazya/whiteboard-model'
import { parse as parseYaml } from 'yaml'
import { type CodecParseResult, codecFailure, codecSuccess } from '../errors.js'
import { type OkfMarkdownDocument, okfMarkdownFrontmatterSchema } from './schema.js'

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

/**
 * Whether a string OPENS with an OKF frontmatter block — the question a
 * caller has to answer before deciding whether a string is a whole document
 * or only a body.
 *
 * Shares `FRONTMATTER_PATTERN` with `parseOkf` deliberately, and that is the
 * whole point of it living here: a caller that reimplemented the test would
 * eventually disagree with the parser about what a block is, and both ways
 * of disagreeing are bad — treat a document as a body and it gets a second
 * frontmatter wrapped around its first; treat a body as a document and it is
 * refused for a block it never claimed to have.
 *
 * TRUE says only that a block OPENS the string, never that its contents
 * parse: a malformed frontmatter is still a mistake for `parseOkf` to
 * report, and a caller must not use this to route one into a body.
 */
export function hasOkfFrontmatter(text: string): boolean {
  return FRONTMATTER_PATTERN.test(text)
}

const RESERVED = new Set<string>(RESERVED_ROOT_KEYS)

/**
 * OKF §4.1: consumers SHOULD preserve unknown frontmatter keys when
 * round-tripping. Every root key this package does not model is therefore
 * collected into `facetsRaw` rather than dropped — which is what a plain
 * `z.object` parse does, silently, since Zod strips unrecognized keys.
 *
 * The keys that reach here are producer-authored, so `__proto__` is a
 * possible one: the bucket is built prototype-less so assigning it defines
 * an own property instead of reaching the prototype's setter.
 *
 * `facetsRaw` itself is deliberately NOT reserved. It is this package's
 * internal envelope field, never a key OKF gives meaning to, so a document
 * that happens to carry one at the root is preserved like any other unknown
 * key — nested one level, and spread back out unchanged on serialise.
 */
function routeUnknownRootKeys(frontmatter: object): Record<string, unknown> {
  const reserved: Record<string, unknown> = {}
  const raw: Record<string, unknown> = Object.create(null)
  let sawUnknown = false
  for (const [key, value] of Object.entries(frontmatter)) {
    if (RESERVED.has(key)) {
      // §5.2 requires a consumer to read a bare `verified` mapping as a
      // one-element list. Widening here rather than in the schema keeps every
      // published schema JSON-Schema-representable — see `normalizeOkfVerified`.
      reserved[key] = key === 'verified' ? normalizeOkfVerified(value) : value
      continue
    }
    raw[key] = value
    sawUnknown = true
  }
  return sawUnknown ? { ...reserved, facetsRaw: raw } : reserved
}

export function parseOkf(text: string): CodecParseResult<OkfMarkdownDocument> {
  const match = FRONTMATTER_PATTERN.exec(text)
  if (match === null) {
    return codecFailure(
      'frontmatter-schema',
      // Names the SHAPE, because "does not start with a --- block" tells a
      // caller what is wrong and not what to send. Measured: three trials
      // across the eval lane's rounds 20a-20d passed a bare markdown body
      // here and each paid a retry.
      //
      // `type` is the one key the schema requires (`coreFacetsSchema`, every
      // other field optional), and this exact string is verified to parse by
      // a test rather than read off the schema by eye.
      'document does not start with a --- frontmatter block. A minimal OKF document is `---`, a `type:` line, `---`, then the body',
    )
  }
  const [, yamlText, body] = match

  let rawFrontmatter: unknown
  try {
    rawFrontmatter = parseYaml(yamlText)
  } catch (error) {
    return codecFailure('yaml', `malformed YAML frontmatter: ${(error as Error).message}`)
  }

  // A non-object frontmatter (a scalar, a list, null) is passed through
  // unchanged so the schema reports it, rather than being routed into a
  // bucket it cannot fill.
  const candidate =
    typeof rawFrontmatter === 'object' && rawFrontmatter !== null && !Array.isArray(rawFrontmatter)
      ? routeUnknownRootKeys(rawFrontmatter)
      : rawFrontmatter

  const parsed = okfMarkdownFrontmatterSchema.safeParse(candidate)
  if (!parsed.success) {
    return codecFailure(
      'frontmatter-schema',
      'frontmatter failed OKF schema validation',
      parsed.error,
    )
  }

  return codecSuccess({ frontmatter: parsed.data, body })
}
