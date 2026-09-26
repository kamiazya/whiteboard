/**
 * Where a WRAPPED workspace key sits between tabs (ADR-0042 decision 6).
 *
 * What is stored is ciphertext: the workspace key sealed under a key derived
 * from a passkey's `prf` output (`daemon-client`'s `replica-key-wrap.ts`).
 * Whatever later owns this origin reads these bytes and holds nothing — that
 * is the whole point, and it is the scenario
 * `docs/explanation/security-model.md` records as the one only encryption
 * reaches.
 *
 * **localStorage rather than IndexedDB**, deliberately. The requirement is
 * per-origin and surviving a tab close, which both satisfy; the blob is
 * ~120 bytes; and this way costs no `DB_VERSION` bump, no object store, no
 * entry in `idb-stored-shapes-surface.test.ts`'s ledger and no migration. It also
 * sits beside the passkey pin it is useless without, and the read-plane
 * smoke already scans localStorage for key bytes — so the guard that matters
 * is pointed at it for free.
 *
 * A record that does not parse reads as ABSENT, the posture `loadPasskeys`
 * takes for a corrupt pin: a cold start then asks the daemon, which is what
 * it would do anyway. Throwing from a store into an unlock path would turn a
 * recoverable state into an error nobody can act on.
 */
import {
  type WrappedWorkspaceKey,
  wrappedWorkspaceKeySchema,
} from '@kamiazya/whiteboard-daemon-client/replica-key-wrap'
import { readStoredRecord } from './stored-record.js'

const STORE_KEY = 'whiteboard:replica-sealed-keys'

/**
 * One flat record rather than nesting, so a read is one parse. The separator
 * is NUL because it cannot occur in a URL or a ULID, so no pair of
 * (daemon, workspace) values can collide by spelling.
 */
const SEPARATOR = '\u0000'

/** Same normalisation the passkey pin store uses, so one daemon is one key. */
const daemonKey = (daemonBaseUrl: string): string => daemonBaseUrl.replace(/\/+$/, '')

const entryKey = (daemonBaseUrl: string, workspaceId: string): string =>
  `${daemonKey(daemonBaseUrl)}${SEPARATOR}${workspaceId}`

function load(): Record<string, WrappedWorkspaceKey> {
  let raw: string | null
  try {
    raw = localStorage.getItem(STORE_KEY)
  } catch {
    // A browser refusing storage: nothing cached, the same as a cold start.
    return {}
  }
  return readStoredRecord(raw, wrappedWorkspaceKeySchema)
}

function save(records: Record<string, WrappedWorkspaceKey>): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(records))
  } catch {
    // A browser refusing storage (private mode, a full quota) costs the
    // cold start and nothing else: the session already holds its key in
    // memory, so the tab carries on and only the NEXT one has to ask.
  }
}

export function loadWrappedKey(
  daemonBaseUrl: string,
  workspaceId: string,
): WrappedWorkspaceKey | null {
  return load()[entryKey(daemonBaseUrl, workspaceId)] ?? null
}

export function saveWrappedKey(
  daemonBaseUrl: string,
  workspaceId: string,
  blob: WrappedWorkspaceKey,
): void {
  save({ ...load(), [entryKey(daemonBaseUrl, workspaceId)]: blob })
}

export function dropWrappedKey(daemonBaseUrl: string, workspaceId: string): void {
  const { [entryKey(daemonBaseUrl, workspaceId)]: _dropped, ...rest } = load()
  save(rest)
}

/**
 * Every pair of one daemon, for a disconnect. A blob that outlived the
 * connection is a key on disk for a daemon this browser no longer talks to.
 */
export function dropWrappedKeysForDaemon(daemonBaseUrl: string): void {
  const prefix = `${daemonKey(daemonBaseUrl)}${SEPARATOR}`
  const kept = Object.fromEntries(Object.entries(load()).filter(([key]) => !key.startsWith(prefix)))
  save(kept)
}
