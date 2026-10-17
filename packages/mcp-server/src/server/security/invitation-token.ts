/**
 * The shape of an invitation link's token, apart from the store that mints
 * it: the sign-in route refuses a malformed one before it stores anything,
 * and a route may not reach into a store.
 */

export const INVITATION_TOKEN_BYTES = 32

// 32 bytes in unpadded base64url are always 43 characters of this alphabet.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/

/** Whether `value` could be a token `createLink` minted — said without a lookup. */
export function isInvitationTokenShaped(value: string): boolean {
  return TOKEN_SHAPE.test(value)
}
