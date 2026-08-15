// The other half of manipulation-tokens.test.ts: the tokens must EXIST, in
// both themes, in the real stylesheet — a jsdom string check cannot see
// that (`?raw` on CSS imports returns an empty string), so this reads the
// computed values in a real browser.
import { afterEach, expect, it } from 'vitest'
import '../../index.css'

const TOKENS = ['--manipulation', '--manipulation-guide', '--manipulation-halo'] as const

afterEach(() => document.documentElement.classList.remove('dark'))

function readAll(): Record<string, string> {
  const style = getComputedStyle(document.documentElement)
  return Object.fromEntries(TOKENS.map((t) => [t, style.getPropertyValue(t).trim()]))
}

it('defines every manipulation token, and dark mode changes each one', () => {
  const light = readAll()
  for (const token of TOKENS) {
    expect({ token, value: light[token] }).not.toEqual({ token, value: '' })
  }

  document.documentElement.classList.add('dark')
  const dark = readAll()
  for (const token of TOKENS) {
    expect({ token, value: dark[token] }).not.toEqual({ token, value: '' })
    // A token whose dark value equals its light value was forgotten in one
    // theme — the exact drift the old hardcoded #2563eb shipped with.
    expect({ token, changed: dark[token] !== light[token] }).toEqual({ token, changed: true })
  }
})
