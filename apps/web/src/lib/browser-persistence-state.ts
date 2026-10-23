export type BrowserPersistenceState =
  | { kind: 'saved'; lastSavedAt: null | string }
  /**
   * `landedAt` is when a write last landed while edits were still unsaved
   * behind it (epoch ms). A burst of typing is one unbroken unsaved span even
   * though every write in it lands, so the span's length says nothing about
   * whether the store is keeping up; the time since a write landed does.
   */
  | { kind: 'pending'; lastSavedAt: null | string; landedAt?: number }
  | { kind: 'saving'; lastSavedAt: null | string }
  | { kind: 'degraded'; reason: string; message: string; lastSavedAt: null | string }
