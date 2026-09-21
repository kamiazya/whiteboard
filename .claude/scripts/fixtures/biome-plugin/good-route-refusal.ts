// Fixture: the JSON refusal every other route on this daemon answers with,
// plus the two shapes the rule must NOT flag — the OAuth approval page's
// HTML, and its body-limit error, which is text on a browser-facing endpoint
// by design.
declare const app: { all: (path: string, handler: (c: Ctx) => unknown) => void }
declare const caught: { message: string }
declare const parsed: { error: never }
declare function errorBody(code: string, message?: string): unknown
declare function invalidRequestBody(error: never): unknown
interface Ctx {
  json: (body: unknown, status: number) => unknown
  text: (body: string, status: number) => unknown
  html: (body: string) => unknown
}

export function right(): void {
  app.all('/api/debug', (c) => c.json({ error: 'not_found' }, 404))
  // The reason in the slot that carries reasons, the code in the slot that
  // carries codes — including when the reason IS an exception's message.
  app.all('/api/one', (c) => c.json(errorBody('document_not_found', caught.message), 404))
  app.all('/api/two', (c) => c.json(invalidRequestBody(parsed.error), 400))
  app.all('/oauth/authorize', (c) => c.html('<!doctype html>'))
  app.all('/oauth/token', (c) => c.text('Payload too large', 413))
}
