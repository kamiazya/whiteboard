// Drives `startServerModeHttp` without a listener. Server mode refuses a
// plain-http public URL, so a test cannot bind a real port and reach it as one;
// instead `@hono/node-server`'s `serve` is replaced (in the test file, with
// `vi.mock('@hono/node-server', async () => (await import(...)).nodeServerStub)`)
// and the handler the root would have served is called in-process. Test support
// only.

type Handler = (request: Request) => Response | Promise<Response>

const captured: { handler?: Handler } = {}

export const nodeServerStub = {
  serve(options: { fetch: Handler }) {
    captured.handler = options.fetch
    return {
      listening: true,
      once: () => {},
      removeListener: () => {},
      close: (done: () => void) => done(),
    }
  },
}

/** A request to the handler the root served, as a client over the network would make it. */
export function toServedServer(
  input: Request | URL | string,
  init?: RequestInit,
): Promise<Response> {
  if (captured.handler === undefined) throw new Error('startServerModeHttp has not served yet')
  const request =
    input instanceof Request ? input : new Request(input instanceof URL ? input.href : input, init)
  return Promise.resolve(captured.handler(request))
}
