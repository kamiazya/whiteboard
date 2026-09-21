// Fixture: Hono's built-in 404 on an API route. It answers text/plain, so a
// caller doing `await res.json()` on the refusal gets a SyntaxError rather
// than the reason — the shape #1521 fixed on the files router.
declare const app: { all: (path: string, handler: (c: Ctx) => unknown) => void }
interface Ctx {
  notFound: () => unknown
  json: (body: unknown, status: number) => unknown
}
declare const caught: { message: string }
declare const parsed: { issues: unknown[] }

export function wrong(): void {
  app.all('/api/debug', (c) => c.notFound())
  // An exception's message in the slot a client switches on.
  app.all('/api/one', (c) => c.json({ error: caught.message }, 404))
  // The reason in a field the contract does not admit.
  app.all('/api/two', (c) => c.json({ error: 'invalid_request', issues: parsed.issues }, 400))
}
