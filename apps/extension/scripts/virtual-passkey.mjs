// A virtual passkey for a Chromium driven over CDP, so a WebAuthn prompt —
// the offline-read opt-in and unlock (ADR-0042, ADR-0050) — is answered with
// nobody at the keyboard.
//
// What it cannot do is outlive the CDP traffic around it. Measured against
// Chromium 1243 headless: a virtual authenticator is gone when the session
// that added it closes, AND when any OTHER session attached to the same tab
// detaches — even a bare attach that never touched WebAuthn. A Playwright
// `connectOverCDP` that disconnects is such a detach. Restoring the saved
// credentials into a new authenticator does not help: `WebAuthn.Credential`
// carries no PRF secret, so a restored credential answers with no PRF output
// and an offline copy sealed under the old one stays sealed.

/**
 * A platform-style authenticator with PRF and user verification, answering
 * every prompt on its own — what a person's passkey provider does after they
 * confirm. The PRF extension is what derives the key an offline copy is
 * sealed with; without it an opt-in has nothing to seal with.
 */
export function prfAuthenticatorOptions() {
  return {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    hasPrf: true,
    automaticPresenceSimulation: true,
  }
}

/**
 * @typedef {{
 *   send: (method: string, params?: object, sessionId?: string) => Promise<any>,
 *   on: (event: string, handler: (params: any) => void) => void,
 * }} BrowserSession a browser-level CDP connection in flat-session mode
 */

/** @typedef {{ sessionId: string, url: string, authenticatorId: string }} ArmedPage */

/** What Chromium answers once another session's detach has taken the authenticator. */
const AUTHENTICATOR_LOST = /not been enabled|Could not find a Virtual Authenticator/

/**
 * Adds an authenticator to every page target of the browser — those open now
 * and any opened later, by Playwright, an agent or a person. Each new page is
 * held at its start until its authenticator is in place, so a page that asks
 * for a passkey on load cannot ask before there is one.
 *
 * Each page is then watched, and given a fresh authenticator when another
 * client's detach has taken its own (see the top of this file). That keeps
 * NEW passkeys working; the credentials the lost one held are gone, which
 * `onReset` is there to say.
 *
 * @param {BrowserSession} session
 * @param {{
 *   pollMs?: number,
 *   onAdded: (page: ArmedPage) => void,
 *   onReset: (page: ArmedPage) => void,
 *   onError: (err: Error) => void,
 * }} report
 * @returns {Promise<{ stop: () => void }>}
 */
export async function armVirtualPasskeys(session, { pollMs = 1_000, onAdded, onReset, onError }) {
  /** @type {Map<string, ReturnType<typeof setInterval>>} */
  const watched = new Map()
  const asError = (err) => (err instanceof Error ? err : new Error(String(err)))

  async function addAuthenticator(sessionId) {
    await session.send('WebAuthn.enable', {}, sessionId)
    const { authenticatorId } = await session.send(
      'WebAuthn.addVirtualAuthenticator',
      { options: prfAuthenticatorOptions() },
      sessionId,
    )
    return authenticatorId
  }

  function unwatch(sessionId) {
    clearInterval(watched.get(sessionId))
    watched.delete(sessionId)
  }

  function watch(page) {
    let current = page
    let checking = false
    const timer = setInterval(async () => {
      if (checking) return
      checking = true
      try {
        await session.send(
          'WebAuthn.getCredentials',
          { authenticatorId: current.authenticatorId },
          current.sessionId,
        )
      } catch (err) {
        if (!AUTHENTICATOR_LOST.test(asError(err).message)) {
          // The session itself is gone: the tab closed under the poll.
          unwatch(current.sessionId)
          return
        }
        try {
          current = { ...current, authenticatorId: await addAuthenticator(current.sessionId) }
          onReset(current)
        } catch (addErr) {
          onError(asError(addErr))
        }
      } finally {
        checking = false
      }
    }, pollMs)
    timer.unref?.()
    watched.set(page.sessionId, timer)
  }

  session.on('Target.detachedFromTarget', ({ sessionId }) => unwatch(sessionId))
  session.on('Target.attachedToTarget', ({ sessionId, targetInfo }) => {
    void (async () => {
      try {
        if (targetInfo.type !== 'page') return
        const page = {
          sessionId,
          url: targetInfo.url,
          authenticatorId: await addAuthenticator(sessionId),
        }
        onAdded(page)
        watch(page)
      } catch (err) {
        onError(asError(err))
      } finally {
        // A target closed mid-way answers with an error here; nothing waits on it.
        await session.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {})
      }
    })()
  })
  await session.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  })
  return {
    stop() {
      // A Map's iterator is live: deleting the entry it is on still visits
      // every later one, so no snapshot of the keys is needed.
      for (const sessionId of watched.keys()) unwatch(sessionId)
    },
  }
}

/**
 * One browser-level CDP connection over Node's WebSocket, in flat-session
 * mode: a page's commands travel on this same socket, tagged with its
 * session id.
 *
 * @param {string} webSocketDebuggerUrl the browser endpoint `/json/version` names
 * @returns {Promise<BrowserSession & { close: () => void }>}
 */
export async function connectBrowserSession(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl)
  await new Promise((open, refuse) => {
    socket.addEventListener('open', open, { once: true })
    socket.addEventListener('error', () => refuse(new Error('CDP connection refused')), {
      once: true,
    })
  })
  const pending = new Map()
  const handlers = new Map()
  let lastId = 0
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data))
    if (message.id !== undefined) {
      const waiter = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) waiter?.refuse(new Error(`${message.error.message} (${waiter.method})`))
      else waiter?.answer(message.result)
      return
    }
    // Only an event this module subscribed to is dispatched: the method name
    // comes off the wire, so it is a key to look up, never a call target.
    const handler = typeof message.method === 'string' ? handlers.get(message.method) : undefined
    if (typeof handler === 'function') handler(message.params)
  })
  socket.addEventListener('close', () => {
    for (const waiter of pending.values()) waiter.refuse(new Error('CDP connection closed'))
    pending.clear()
  })
  return {
    send(method, params, sessionId) {
      lastId += 1
      const id = lastId
      return new Promise((answer, refuse) => {
        pending.set(id, { answer, refuse, method })
        socket.send(
          JSON.stringify({ id, method, params: params ?? {}, ...(sessionId ? { sessionId } : {}) }),
        )
      })
    },
    on(event, handler) {
      handlers.set(event, handler)
    },
    close: () => socket.close(),
  }
}
