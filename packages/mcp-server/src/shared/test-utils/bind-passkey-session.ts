import {
  pairingTokenResponseSchema,
  sessionAssertChallengeResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/pairing'
import {
  buildAssertion,
  registrationFor,
  WEBAUTHN_FLAG_BE,
  WEBAUTHN_FLAG_UP,
  WEBAUTHN_FLAG_UV,
} from './webauthn-fixtures.js'

const FLAGS = WEBAUTHN_FLAG_UP | WEBAUTHN_FLAG_UV | WEBAUTHN_FLAG_BE

/**
 * Over a REAL running daemon (not an in-process Hono app): mint an origin
 * pairing token, pin a fresh passkey under it, and bind the session to that
 * passkey through the session-assert challenge. The shape every real-socket
 * membership test needs; the in-process tests keep their own `app.request`
 * variant. Throws on any unexpected status so a caller's assertions are
 * about membership, never about the fixture.
 */
export async function bindPasskeySessionOverHttp(
  port: number,
  origin: string,
): Promise<{ token: string; credentialId: string }> {
  const base = `http://127.0.0.1:${port}`
  const { keypair, ...registration } = registrationFor(new URL(origin).hostname)
  const credentialId = registration.credentialId
  const tokenRes = await fetch(`${base}/api/pairing/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ grantType: 'origin' }),
  })
  const { token } = pairingTokenResponseSchema.parse(await tokenRes.json())
  const authed = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    Origin: origin,
  }
  const pinRes = await fetch(`${base}/api/pairing/credentials`, {
    method: 'POST',
    headers: authed,
    body: JSON.stringify(registration),
  })
  if (pinRes.status !== 201) throw new Error(`passkey pin answered ${pinRes.status}`)
  const challengeRes = await fetch(`${base}/api/pairing/session-assert/challenge`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Origin: origin },
  })
  const { challenge } = sessionAssertChallengeResponseSchema.parse(await challengeRes.json())
  const assertion = buildAssertion({
    privateKey: keypair.privateKey,
    rpId: new URL(origin).hostname,
    origin,
    challenge: Buffer.from(challenge, 'base64url'),
    flags: FLAGS,
    signCount: 1,
  })
  const assertRes = await fetch(`${base}/api/pairing/session-assert`, {
    method: 'POST',
    headers: authed,
    body: JSON.stringify({
      credentialId,
      authenticatorData: assertion.authenticatorData.toString('base64url'),
      clientDataJSON: assertion.clientDataJSON.toString('base64url'),
      signature: assertion.signature.toString('base64url'),
    }),
  })
  if (assertRes.status !== 200) throw new Error(`session-assert answered ${assertRes.status}`)
  return { token, credentialId }
}
