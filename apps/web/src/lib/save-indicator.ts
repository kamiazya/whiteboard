import type { BrowserPersistenceState } from './browser-persistence-state.js'
import type { ConnectionState } from './connection-state.js'

/**
 * What the document row's save status says. `problem` is the only tone worth
 * announcing: the rest are the ordinary rhythm of editing.
 */
export interface SaveIndicator {
  readonly tone: 'saved' | 'saving' | 'problem'
  readonly label: string
}

/** The two accounts a page already holds about the open document. */
export interface SaveState {
  readonly persistence: BrowserPersistenceState
  readonly connection: ConnectionState
}

const SAVED: SaveIndicator = { tone: 'saved', label: 'Saved' }
const SAVING: SaveIndicator = { tone: 'saving', label: 'Saving…' }
const RECONNECTING: SaveIndicator = { tone: 'saving', label: 'Reconnecting…' }
const STORAGE_PROBLEM: SaveIndicator = { tone: 'problem', label: 'Not saved — storage problem' }
const OFFLINE: SaveIndicator = { tone: 'problem', label: 'Offline — changes kept here' }

/**
 * Where an edit stands, from the two accounts a page already holds: the
 * persistence facts (is a write waiting) and the keeper's health (is it
 * keeping). A keeper that is not keeping outranks a pending write, since the
 * write is what is failing.
 */
export function saveIndicatorOf(
  persistence: BrowserPersistenceState,
  connection: ConnectionState,
): SaveIndicator {
  const waiting = persistence.kind === 'pending' || persistence.kind === 'saving'
  switch (connection.keeper) {
    case 'browser':
      if (connection.storage !== 'ok') return STORAGE_PROBLEM
      break
    case 'daemon':
      if (connection.session === 'write-failed') return STORAGE_PROBLEM
      if (connection.session === 'sync-off' || connection.session === 'not-opened') return OFFLINE
      if (connection.session === 'reconnecting') return RECONNECTING
      break
    case 'replica':
      return connection.storage === 'failed' ? STORAGE_PROBLEM : OFFLINE
  }
  return waiting ? SAVING : SAVED
}
