// Ambient declaration for Vite's `?url` asset-import suffix, used by
// font-loading.ts to fetch the vendored Roboto face from a same-origin URL
// (never a `data:` URI — apps/web's CSP has no `font-src` override, so it
// inherits `default-src 'self'`). `vite/client`'s own ambient types only
// cover a fixed extension allowlist that does not include `.ttf`.
declare module '*.ttf?url' {
  const url: string
  export default url
}
