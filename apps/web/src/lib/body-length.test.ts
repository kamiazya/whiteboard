// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { bodyLengthLabel } from './body-length.js'

describe('bodyLengthLabel', () => {
  it('counts words in prose written with spaces, markup and punctuation out', () => {
    expect(bodyLengthLabel('# Hi there, **again**!')).toBe('3 words')
    expect(bodyLengthLabel('one')).toBe('1 word')
    expect(bodyLengthLabel('')).toBe('0 words')
  })

  it('counts characters when the body is mostly CJK', () => {
    expect(bodyLengthLabel('来期は検索を改善します。')).toBe('11 characters')
    expect(bodyLengthLabel('한국어 문장')).toBe('5 characters')
    expect(bodyLengthLabel('字')).toBe('1 character')
  })

  it('keeps counting words when a few CJK characters sit in English prose', () => {
    expect(bodyLengthLabel('The team in 大阪 ships the search work this quarter')).toBe('9 words')
  })
})
