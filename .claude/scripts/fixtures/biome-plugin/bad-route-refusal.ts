// Fixture: Hono's built-in 404 on an API route. It answers text/plain, so a
// caller doing `await res.json()` on the refusal gets a SyntaxError rather
// than the reason — the shape #1521 fixed on the files router.
declare const app: { all: (path: string, handler: (c: Ctx) => unknown) => void }
interface Ctx {
  notFound: () => unknown
  json: (body: unknown, status: number) => unknown
}

export function wrong(): void {
  app.all('/api/debug', (c) => c.notFound())
}
