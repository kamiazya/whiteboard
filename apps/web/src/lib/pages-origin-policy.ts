// Provisional production origin for the hosted app.
// Update to the confirmed canonical domain once it is assigned.
export const PROVISIONAL_PRODUCTION_ORIGIN = 'https://whiteboard.pages.dev' as const

const PAGES_DOMAIN = 'whiteboard.pages.dev'

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
  // Credentials are also caught by origin normalisation, but checked explicitly for clarity.
  if (url.origin !== candidate || url.username !== '' || url.password !== '') {
    return 'non-bare-origin'
  }

  // Insecure scheme check before hostname checks so http://localhost returns 'insecure'.
  if (url.protocol !== 'https:') return 'insecure'

  const host = url.hostname
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') {
    return 'localhost'
  }

  if (candidate === PROVISIONAL_PRODUCTION_ORIGIN) return 'production'

  // Any subdomain of the pages domain is a Cloudflare preview deploy.
  if (host.endsWith(`.${PAGES_DOMAIN}`)) return 'preview'

  // Custom domain or unrecognised pages.dev project — deferred.
  return 'custom-domain-deferred'
}

export function isProductionPagesOrigin(candidate: string): boolean {
  return classifyPagesOrigin(candidate) === 'production'
}
