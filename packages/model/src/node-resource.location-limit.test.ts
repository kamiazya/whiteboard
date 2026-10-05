import { describe, expect, it } from 'vitest'
import {
  NODE_LOCATION_MAX_CHARS,
  nodeFileInputSchema,
  nodeResourceSchema,
  nodeSubpathInputSchema,
  nodeUrlInputSchema,
} from './node-resource.js'

const messageOf = (parsed: { success: boolean; error?: { issues: { message: string }[] } }) =>
  parsed.success ? '' : (parsed.error?.issues[0]?.message ?? '')

const url = (length: number) => {
  const head = 'https://example.com/'
  return head + 'a'.repeat(length - head.length)
}

describe('a node location as a write accepts it', () => {
  it('holds a link URL to 8,192 characters, the size its render cost was measured at', () => {
    // A literal, not the constant: every other case reads the limit back from
    // itself, so a changed limit would pass them all.
    expect(NODE_LOCATION_MAX_CHARS).toBe(8192)
    expect(nodeUrlInputSchema.safeParse(url(8192)).success).toBe(true)
    expect(nodeUrlInputSchema.safeParse(url(8193)).success).toBe(false)
  })

  it('still refuses a link URL that is not a URL', () => {
    expect(nodeUrlInputSchema.safeParse('not a url').success).toBe(false)
  })

  it('holds a file path and a subpath to the same limit', () => {
    expect(nodeFileInputSchema.safeParse('a'.repeat(NODE_LOCATION_MAX_CHARS)).success).toBe(true)
    expect(nodeFileInputSchema.safeParse('a'.repeat(NODE_LOCATION_MAX_CHARS + 1)).success).toBe(
      false,
    )
    const subpath = (length: number) => `#${'a'.repeat(length - 1)}`
    expect(nodeSubpathInputSchema.safeParse(subpath(NODE_LOCATION_MAX_CHARS)).success).toBe(true)
    expect(nodeSubpathInputSchema.safeParse(subpath(NODE_LOCATION_MAX_CHARS + 1)).success).toBe(
      false,
    )
    expect(nodeSubpathInputSchema.safeParse('heading').success).toBe(false)
  })

  it('refuses in words that name what is too long and the limit', () => {
    expect(messageOf(nodeUrlInputSchema.safeParse(url(NODE_LOCATION_MAX_CHARS + 1)))).toBe(
      `a link's URL is longer than the ${NODE_LOCATION_MAX_CHARS}-character limit`,
    )
    expect(messageOf(nodeFileInputSchema.safeParse('a'.repeat(NODE_LOCATION_MAX_CHARS + 1)))).toBe(
      `a file's path is longer than the ${NODE_LOCATION_MAX_CHARS}-character limit`,
    )
    expect(
      messageOf(nodeSubpathInputSchema.safeParse(`#${'a'.repeat(NODE_LOCATION_MAX_CHARS)}`)),
    ).toBe(`a file's subpath is longer than the ${NODE_LOCATION_MAX_CHARS}-character limit`)
  })

  it('leaves the STORED resource unbounded, so one written before the limit still reads', () => {
    expect(
      nodeResourceSchema.safeParse({
        mimeType: 'text/uri-list',
        location: url(NODE_LOCATION_MAX_CHARS * 4),
      }).success,
    ).toBe(true)
    expect(
      nodeResourceSchema.safeParse({
        mimeType: 'application/octet-stream',
        location: 'a'.repeat(NODE_LOCATION_MAX_CHARS * 4),
        subpath: `#${'a'.repeat(NODE_LOCATION_MAX_CHARS * 4)}`,
      }).success,
    ).toBe(true)
  })
})
