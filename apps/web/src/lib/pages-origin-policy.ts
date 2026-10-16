import { HOSTED_APP_ORIGIN } from '@kamiazya/whiteboard-daemon-client/hosted-app'
import { isLoopbackHostname } from '@kamiazya/whiteboard-daemon-client/loopback-host'

// Provisional production origin for the hosted app. It is shared with the
// extension, which admits only this page, and the daemon, which opens it, so
// a move to the canonical domain is made in daemon-client, not here.
export const PROVISIONAL_PRODUCTION_ORIGIN = HOSTED_APP_ORIGIN

const PAGES_DOMAIN = new URL(HOSTED_APP_ORIGIN).hostname

// Classification of an origin candidate against the Cloudflare Pages hosting policy.
// 'production'             — exact provisional production origin; accepted.
// 'preview'                — hash.<project>.pages.dev preview deploy; rejected.
// 'insecure'               — non-https origin; rejected.
// 'localhost'              — loopback address; rejected for production policy.
// 'non-bare-origin'        — invalid URL, wildcard, path, query, fragment, or credentials.
// 'custom-domain-deferred' — valid HTTPS origin but not a recognised pages.dev address;
//                            deferred until the canonical custom domain is confirmed.
export type PagesOriginClass =
  | 'production'
  | 'preview'
  | 'insecure'
  | 'localhost'
  | 'non-bare-origin'
  | 'custom-domain-deferred'

export function classifyPagesOrigin(candidate: string): PagesOriginClass {
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return 'non-bare-origin'
  }

  // Wildcards are never valid in origins.
  if (url.hostname.includes('*')) return 'non-bare-origin'

  // Bare-origin: scheme + host + optional port, nothing else (no path, query, hash, credentials).
  // `URL.origin` carries none of those, so any candidate that has one differs from it.
  if (url.origin !== candidate) return 'non-bare-origin'

  // Insecure scheme check before hostname checks so http://localhost returns 'insecure'.
  if (url.protocol !== 'https:') return 'insecure'

  const host = url.hostname
  if (isLoopbackHostname(host)) return 'localhost'

  if (candidate === PROVISIONAL_PRODUCTION_ORIGIN) return 'production'

  // Any subdomain of the pages domain is a Cloudflare preview deploy.
  if (host.endsWith(`.${PAGES_DOMAIN}`)) return 'preview'

  // Custom domain or unrecognised pages.dev project — deferred.
  return 'custom-domain-deferred'
}
