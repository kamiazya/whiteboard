/**
 * Motion foundation contract (real browser, real compiled CSS):
 *
 * 1. The motion tokens exist on :root so components can consume
 *    `var(--motion-*)` instead of ad-hoc numbers.
 * 2. The base layer ships a `prefers-reduced-motion: reduce` guard that
 *    neutralizes animations AND transitions. Browser test runners cannot
 *    flip the OS media preference per test, so the guard is pinned by
 *    walking the compiled stylesheet for the media rule and its
 *    neutralizing declarations — a real parse through the Tailwind
 *    pipeline, not a source-text grep.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import './index.css'

function collectCssText(): string {
  let out = ''
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    for (const rule of Array.from(rules)) {
      out += `${rule.cssText}\n`
    }
  }
  return out
}

describe('motion foundation', () => {
  beforeAll(async () => {
    // Wait until the imported stylesheet is actually applied.
    await vi.waitFor(() => {
      const v = getComputedStyle(document.documentElement)
        .getPropertyValue('--motion-duration-fast')
        .trim()
      if (v === '') throw new Error('index.css not applied yet')
    })
  })

  it('defines the motion tokens on :root', () => {
    const styles = getComputedStyle(document.documentElement)
    expect(styles.getPropertyValue('--motion-duration-fast').trim()).toBe('150ms')
    expect(styles.getPropertyValue('--motion-duration-normal').trim()).toBe('220ms')
    expect(styles.getPropertyValue('--motion-ease-out').trim()).toContain('cubic-bezier')
  })

  it('ships a prefers-reduced-motion guard neutralizing animations and transitions', () => {
    const css = collectCssText()
    const mediaIdx = css.indexOf('prefers-reduced-motion: reduce')
    expect(mediaIdx).toBeGreaterThan(-1)
    const afterMedia = css.slice(mediaIdx)
    expect(afterMedia).toContain('animation-duration: 0.01ms')
    expect(afterMedia).toContain('transition-duration: 0.01ms')
  })
})
