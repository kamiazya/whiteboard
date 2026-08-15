/**
 * Whether this browser offers element fullscreen at all.
 *
 * iPhone Safari does not: the Fullscreen API is video-only there (iPad
 * Safari and every desktop browser do offer it), so `Fullscreen` was a
 * button that visibly did nothing on a phone. `document.fullscreenEnabled`
 * is exactly the standard's answer to this question — it is `false` when
 * fullscreen is unavailable, including when an embedding iframe withholds
 * the permission.
 *
 * Only an explicit `false` counts as unsupported: a runtime that does not
 * implement the property at all (jsdom) reports `undefined`, and hiding
 * the affordance there would mean tests exercising a UI no real browser
 * shows. Safari's legacy `webkitFullscreenEnabled` is consulted for the
 * same reason — an older WebKit that answers only under the prefix must
 * not be read as "unsupported".
 */
export function isFullscreenSupported(doc: Document = document): boolean {
  const legacy = (doc as Document & { webkitFullscreenEnabled?: boolean }).webkitFullscreenEnabled
  if (doc.fullscreenEnabled === false && legacy !== true) return false
  return true
}
