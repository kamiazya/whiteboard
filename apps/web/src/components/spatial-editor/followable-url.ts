/**
 * Whether a link node's URL is safe to FOLLOW from the editor.
 *
 * The model schema deliberately stays at `z.url()` (JSON Canvas puts
 * no scheme restriction on the field), but following a reference is this
 * editor's own action — and a `javascript:` or `data:` URL handed to
 * `window.open` executes in the app's origin. Documents arrive via sync and
 * import, not only via our own dialog, so the guard must hold at the open
 * sink regardless of where the node came from.
 */
export function isFollowableUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}
