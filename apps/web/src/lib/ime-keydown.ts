/**
 * Is this keydown part of an IME composition — the Enter that confirms a
 * Japanese conversion rather than the Enter that means "I am done"?
 *
 * Every single-line input that commits or blurs on Enter must check this
 * first, or a CJK typist loses the field mid-word: the conversion-confirming
 * keypress would submit a half-typed value. Two spellings reach the handler:
 * `isComposing` (the UI Events flag, set by Chrome/Firefox on the confirming
 * keydown) and the legacy `keyCode === 229` WebKit/older engines emit for any
 * keydown fired while an IME is active.
 *
 * Takes the NATIVE event's fields — React callers pass `event.nativeEvent`
 * (the synthetic event does not carry `isComposing`), window-capture
 * listeners pass the event itself.
 */
export function isImeComposingKeydown(
  event: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>,
): boolean {
  return event.isComposing || event.keyCode === 229
}
