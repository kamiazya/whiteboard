// Shared utilities for *.docs-snapshot.test.tsx files. Each snapshot test
// renders a real component with deterministic mocked data and writes its
// PNG straight to docs/assets/, so the source-of-truth image lives next
// to the markdown that embeds it.
//
// __DOCS_ASSETS_DIR__ is inlined at build time by the vitest define block
// in vitest.docs-snapshots.config.ts (node:path is not available inside
// the browser-mode test bundle).

declare const __DOCS_ASSETS_DIR__: string

export function resolveDocAssetPath(name: `${string}.png`): string {
  return `${__DOCS_ASSETS_DIR__}/${name}`
}

export function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

export interface DocFetchHandler {
  (url: string, init?: RequestInit): Promise<Response> | undefined | Response
}

// Adapt a (url, init) → Response handler to fetch's signature, and reject
// loudly on unhandled URLs so a missing mock fails the test instead of
// silently stalling on a network error.
export function makeFetchMock(handler: DocFetchHandler) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const result = handler(url, init)
    if (result instanceof Promise) return result
    if (result instanceof Response) return result
    throw new Error(`docs-snapshot: unhandled fetch ${init?.method ?? 'GET'} ${url}`)
  }
}
