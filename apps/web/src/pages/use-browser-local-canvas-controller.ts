export type BrowserLocalPersistenceState =
  | { kind: 'saved'; lastSavedAt: null | string }
  | { kind: 'pending'; lastSavedAt: null | string }
  | { kind: 'saving'; lastSavedAt: null | string }
  | { kind: 'degraded'; reason: string; message: string; lastSavedAt: null | string }
