import { RESERVED_ROOT_KEYS } from '@kamiazya/whiteboard-model'
import { parse as parseYaml } from 'yaml'
import { type CodecParseResult, codecFailure, codecSuccess } from '../errors.js'
import { type OkfMarkdownDocument, okfMarkdownFrontmatterSchema } from './schema.js'

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

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
      reserved[key] = value
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
      'document does not start with a --- frontmatter block',
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
