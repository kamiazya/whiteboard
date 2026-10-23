import { type KeyboardEvent, type RefObject, useEffect } from 'react'

// Prefix match: menuitem, menuitemradio and menuitemcheckbox all rove alike.
const ITEM_SELECTOR = '[role^="menuitem"]'

const NAVIGATION_KEYS = new Set(['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])

function enabledItems(menu: HTMLElement): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter(
    (el) => !(el instanceof HTMLButtonElement && el.disabled),
  )
}

/**
 * Where focus lands on open: the first labelled action, not a swatch. A
 * colour row leads some menus, and landing on one of its swatches hides what
 * the menu is for; the swatches stay one ArrowUp/ArrowLeft away.
 */
function entryItem(items: readonly HTMLElement[]): HTMLElement | undefined {
  return items.find((el) => el.closest('fieldset,[role="group"]') === null) ?? items[0]
}

function stepFrom(list: readonly HTMLElement[], current: HTMLElement, step: number) {
  const at = list.indexOf(current)
  return list[(at + step + list.length) % list.length]
}

function typeaheadTarget(items: readonly HTMLElement[], current: HTMLElement, key: string) {
  const label = (el: HTMLElement) =>
    (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().toLowerCase()
  const from = items.indexOf(current)
  const ordered = [...items.slice(from + 1), ...items.slice(0, from + 1)]
  return ordered.find((el) => label(el).startsWith(key.toLowerCase()))
}

/** Left/Right stay inside the nearest group (a swatch row); elsewhere they do nothing. */
function sideways(items: readonly HTMLElement[], current: HTMLElement, step: number) {
  const group = current.closest('fieldset,[role="group"]')
  if (group === null) return undefined
  return stepFrom(
    items.filter((el) => group.contains(el)),
    current,
    step,
  )
}

/** The item a key moves focus to, or undefined when the key is not the menu's. */
function targetFor(items: readonly HTMLElement[], current: HTMLElement, key: string) {
  switch (key) {
    case 'ArrowDown':
      return stepFrom(items, current, 1)
    case 'ArrowUp':
      return stepFrom(items, current, -1)
    case 'ArrowRight':
      return sideways(items, current, 1)
    case 'ArrowLeft':
      return sideways(items, current, -1)
    case 'Home':
      return items[0]
    case 'End':
      return items[items.length - 1]
    default:
      return key.length === 1 && key !== ' ' ? typeaheadTarget(items, current, key) : undefined
  }
}

/**
 * The WAI-ARIA menu keyboard model over whatever items a menu draws:
 * focus lands on the first action row when the menu opens (see `entryItem`), exactly one item is a
 * Tab stop (the others are `tabindex=-1` and reached by arrows), and the
 * returned `onKeyDown` handles Arrow/Home/End/typeahead and Escape (which
 * stops propagating, so an enclosing editor does not also act on it).
 *
 * Up/Down walk every item and wrap; Left/Right move within the nearest
 * `group`/`fieldset` (a swatch row) and wrap inside it. Driven through the
 * DOM rather than props because items come from catalogs and from
 * `facet-ui`'s option shell, neither of which can be handed a roving index.
 */
export function useRovingMenu(
  menuRef: RefObject<HTMLElement | null>,
  onEscape: () => void,
): {
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
} {
  // Re-applied after every commit: the item set changes as rows open and close.
  useEffect(() => {
    const menu = menuRef.current
    if (menu === null) return
    const items = enabledItems(menu)
    const active = items.find((el) => el === document.activeElement) ?? entryItem(items)
    for (const item of items) item.tabIndex = item === active ? 0 : -1
  })

  useEffect(() => {
    const menu = menuRef.current
    if (menu === null) return // An item-less menu still takes focus itself so Escape works.
    ;(entryItem(enabledItems(menu)) ?? menu).focus()
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target
      if (!(target instanceof HTMLElement) || !target.matches(ITEM_SELECTOR)) return
      for (const item of enabledItems(menu)) item.tabIndex = item === target ? 0 : -1
    }
    menu.addEventListener('focusin', onFocusIn)
    return () => menu.removeEventListener('focusin', onFocusIn)
  }, [menuRef])

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onEscape()
      return
    }
    const menu = menuRef.current
    if (menu === null || event.altKey || event.ctrlKey || event.metaKey) return
    const current = document.activeElement
    if (!(current instanceof HTMLElement) || !current.matches(ITEM_SELECTOR)) return
    const target = targetFor(enabledItems(menu), current, event.key)
    // Navigation keys are the menu's even when they land nowhere, so the
    // canvas behind never reads them as a nudge.
    if (NAVIGATION_KEYS.has(event.key)) event.stopPropagation()
    if (target === undefined) return
    target.focus()
    event.preventDefault()
  }
  return { onKeyDown }
}
