/**
 * The window `waitForMarkdownSaved` exists to close, replayed against a
 * scripted indicator rather than against a real editor under load.
 *
 * A real reproduction would need typing to outrun the debounce on a
 * saturated machine, which is exactly the condition that makes it rare. The
 * indicator is the only thing the wait reads, so scripting the indicator
 * reproduces the whole of what the wait can see — and does it in under two
 * seconds, every time.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { SAVE_DEBOUNCE_MS } from '../pages/use-markdown-document.js'
import { waitForMarkdownSaved } from './wait-for-saved.js'

const PARTIAL_AT = '2026-08-30T01:00:00.000Z'
const FULL_AT = '2026-08-30T01:00:02.000Z'

function mountChip(): HTMLElement {
  const chip = document.createElement('div')
  chip.setAttribute('data-testid', 'save-status-chip')
  document.body.append(chip)
  return chip
}

function set(chip: HTMLElement, state: string, at: string | null): void {
  chip.setAttribute('data-save-state', state)
  if (at === null) chip.removeAttribute('data-last-saved-at')
  else chip.setAttribute('data-last-saved-at', at)
}

afterEach(() => {
  // Remove the node, never `body.innerHTML = ''`: this file mounts no React
  // root, but a raw DOM wipe is the teardown that leaves roots mounted on
  // detached nodes elsewhere in this repo, and the pattern should not be
  // copied out of here.
  for (const el of document.querySelectorAll('[data-testid="save-status-chip"]')) el.remove()
})

describe('waitForMarkdownSaved', () => {
  it('does not settle on a write that landed BEFORE the last edit registered', async () => {
    const chip = mountChip()
    // The state the failing CI run was in: a mid-typing debounce has written
    // the partial body, and the trailing keystrokes have reached the editor
    // but not yet run setBody, so nothing has re-armed the indicator.
    set(chip, 'saved', PARTIAL_AT)

    setTimeout(() => set(chip, 'pending', PARTIAL_AT), SAVE_DEBOUNCE_MS / 2)
    setTimeout(() => set(chip, 'saved', FULL_AT), SAVE_DEBOUNCE_MS)

    const settledOn = await waitForMarkdownSaved()
    expect(
      settledOn,
      'settled on the partial write — the wait answered for a save that predates the last edit',
    ).toBe(FULL_AT)
  })

  it('settles promptly when the write really is the last one', async () => {
    const chip = mountChip()
    set(chip, 'saved', FULL_AT)
    const started = Date.now()

    await expect(waitForMarkdownSaved()).resolves.toBe(FULL_AT)

    // It costs one settle period and no more: the guard must not turn every
    // save wait into a multi-second stall.
    expect(Date.now() - started).toBeLessThan(SAVE_DEBOUNCE_MS * 4)
  })

  it('keeps waiting while the indicator never reports a write at all', async () => {
    const chip = mountChip()
    set(chip, 'pending', null)
    await expect(waitForMarkdownSaved(300)).rejects.toThrow()
  })

  /**
   * The hole the settle window cannot close, and the CI failure that found
   * it: the trailing keystrokes' commit reached the doc, but the delivery
   * that ARMS the next save arrived later than the window — so the indicator
   * sat on the partial write, unchanged, for the whole of it. A wait built
   * out of a fixed duration cannot tell that apart from a finished document,
   * however long the duration is.
   */
  it('with an anchor: refuses a write that completed BEFORE the last keystroke', async () => {
    const chip = mountChip()
    set(chip, 'saved', PARTIAL_AT)
    const typedAt = Date.parse(PARTIAL_AT) + 1

    // Nothing re-arms for well over the old settle window — exactly what the
    // failing run observed.
    setTimeout(() => set(chip, 'saved', FULL_AT), SAVE_DEBOUNCE_MS * 5)

    await expect(waitForMarkdownSaved({ since: typedAt })).resolves.toBe(FULL_AT)
  })

  it('with an anchor: settles at once on a write that already covers the typing', async () => {
    const chip = mountChip()
    set(chip, 'saved', FULL_AT)
    const started = Date.now()

    await expect(waitForMarkdownSaved({ since: Date.parse(FULL_AT) - 1000 })).resolves.toBe(FULL_AT)
    // No settle sleep in anchored mode: the timestamp IS the proof, so the
    // wait must not spend a debounce period re-confirming it.
    expect(Date.now() - started).toBeLessThan(SAVE_DEBOUNCE_MS)
  })
})
