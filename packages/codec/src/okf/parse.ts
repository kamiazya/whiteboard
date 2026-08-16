import { parse as parseYaml } from 'yaml'
import { type CodecParseResult, codecFailure, codecSuccess } from '../errors.js'
import { type OkfMarkdownDocument, okfMarkdownFrontmatterSchema } from './schema.js'

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

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

  const parsed = okfMarkdownFrontmatterSchema.safeParse(rawFrontmatter)
  if (!parsed.success) {
    return codecFailure(
      'frontmatter-schema',
      'frontmatter failed OKF schema validation',
      parsed.error,
    )
  }

  return codecSuccess({ frontmatter: parsed.data, body })
}
