import { describe, expect, it } from 'vitest'
import { base64ToBytes, base64UrlToBytes, bytesToBase64, bytesToBase64Url } from './base64.js'

const bytes = (...values: number[]) => new Uint8Array(values)

describe('base64 / base64url codec', () => {
  it('encodes the RFC 4648 section 10 vectors, padded', () => {
    const encode = (text: string) => bytesToBase64(new TextEncoder().encode(text))
    expect([encode(''), encode('f'), encode('fo'), encode('foo'), encode('foob')]).toEqual([
      '',
      'Zg==',
      'Zm8=',
      'Zm9v',
      'Zm9vYg==',
    ])
  })

  it('writes the url alphabet without padding', () => {
    // 0xfb 0xff 0xbe is "+/++" in the standard alphabet — every alphabet-specific character.
    const sample = bytes(0xfb, 0xff, 0xbe)
    expect(bytesToBase64(sample)).toBe('+/++')
    expect(bytesToBase64Url(sample)).toBe('-_--')
    expect(bytesToBase64Url(bytes(0xfb, 0xff))).toBe('-_8')
  })

  it('reads the url variant padded or unpadded', () => {
    expect(base64UrlToBytes('-_8')).toEqual(bytes(0xfb, 0xff))
    expect(base64UrlToBytes('-_8=')).toEqual(bytes(0xfb, 0xff))
    expect(base64UrlToBytes('Zg')).toEqual(bytes(0x66))
    expect(base64UrlToBytes('Zg==')).toEqual(bytes(0x66))
  })

  it('reads the standard variant padded or unpadded', () => {
    expect(base64ToBytes('Zm8=')).toEqual(bytes(0x66, 0x6f))
    expect(base64ToBytes('Zm8')).toEqual(bytes(0x66, 0x6f))
  })

  it('reads the empty string as no bytes', () => {
    expect(base64ToBytes('')).toEqual(new Uint8Array(0))
    expect(base64UrlToBytes('')).toEqual(new Uint8Array(0))
  })

  it('answers null for text that is not base64 rather than throwing', () => {
    for (const bad of [
      'Z',
      'Zm9vY',
      'Zm=8',
      'Zm8==',
      'Zg=',
      '=',
      'Zm 8',
      ' Zg==',
      'Zm8\n',
      'Zm8!',
    ]) {
      expect(base64ToBytes(bad), JSON.stringify(bad)).toBeNull()
      expect(base64UrlToBytes(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('refuses the other variant’s alphabet', () => {
    expect(base64ToBytes('-_--')).toBeNull()
    expect(base64UrlToBytes('+/++')).toBeNull()
  })

  it('hands back a view over a plain ArrayBuffer, which BufferSource accepts', () => {
    const decoded = base64ToBytes('Zm9v')
    expect(decoded?.buffer).toBeInstanceOf(ArrayBuffer)
  })

  it('encodes past the argument-list limit of String.fromCharCode', () => {
    const big = new Uint8Array(400_000).fill(0xab)
    expect(base64ToBytes(bytesToBase64(big))).toEqual(big)
  })
})
