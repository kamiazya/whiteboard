# ADR-0028: The routine save state is not shown; the shell mark speaks only for a condition

**Status:** Accepted — the browser page's save chip is removed, the shell mark carries both keepers' health, and the leave-flush that makes the silence honest landed first (#1361)

## Context

A browser-kept document carried a coloured dot beside its title: amber while
an edit was unsaved, emerald once the write landed. The markdown body writes
500ms after a keystroke and the spatial session 300ms after an edit, so while
someone typed the dot flipped every debounce period. Reported as the header
being restless; first answered by cross-fading the colour (#1175), which
softened the flip without removing its cause.

Measured before deciding (Chromium, real IndexedDB, the same typing on both
builds):

| | states seen while typing |
|---|---|
| main | `pending` ↔ `saved`, alternating on every debounce |
| this decision | none — the row has no carrier and the shell mark stays plain |

Three things were also true of the chip and are recorded because they shaped
the answer:

- **It did not know about spatial edits.** Its state came from the page
  controller (renames) and the markdown body's own save. The spatial sync
  session's writes reached IndexedDB and told nobody, so a canvas whose
  nodes were being moved read `Saved` throughout.
- **`HeaderVersionDot`, the ring beside it, had already been deleted** with
  the version history rework (#1245) while `DESIGN.md` still listed it.
- **The daemon page had no equivalent**, by design: its pushes are sent over
  a socket and never acknowledged, so it has no landed/unlanded fact to
  draw. `DESIGN.md` already said the shell mark answers "is my work safe"
  there.

The question the routine dot answered — "is what I just typed written?" —
asks nothing of the person. The write follows within a few hundred
milliseconds, and nothing they could do would change that. A state that asks
nothing and changes constantly is noise in the one place a person is
looking.

## Decision

1. **The routine state is not drawn.** No carrier beside the title; no
   colour for "safe" anywhere in chrome. `amber-500` is the only state
   colour left, meaning "a condition that asks something of you".
2. **The shell mark answers for both keepers**, each with the health it can
   vouch for. The daemon's is its session (`synced` / `reconnecting` /
   `sync-off`, from transport liveness, unchanged). The browser's is its
   storage — `StorageHealth`: `ok` (drawn as nothing), `stuck` (an edit
   unsaved past `STUCK_AFTER_MS` = 5s: filled amber cap), `failed` (the store
   refused a write: broken stroke, hollow amber cap). "Not keeping" shares a
   shape across keepers; the hollow cap is what tells the browser's from the
   daemon's when both are amber and the mark has no word.
3. **The facts are separate from the judgement.** The sync session reports
   `pending` on publish, `saved` once every write behind the edit has
   landed (the store's promise, not the debounce or the commit), `degraded`
   on a refusal — including the browser backend's `storage-failure`, which
   arrives through `onError` while the push's own promise resolves. The page
   merges these with the controller's and the markdown save's facts, worst
   first, and `useStorageHealth` judges them with a clock. Only the judgement
   reaches chrome.
4. **"Is it saved" is answered on asking.** The mark's popover states when
   the last write landed. The History panel is where a named version is
   taken and seen.
5. **The favicon follows the same rule**: quiet unless stuck, reconnecting,
   refused or rejected. Its green and blue are gone with the chip.
6. **Tests read the facts, not the chrome.** The page publishes them on a
   hidden element (`persistence-state`), so a wait can still require a
   landed write that covers what was typed.

## Consequences

- The silence is honest only if leaving cannot lose the unsaved window.
  #1361 flushes on `pagehide` and `visibilitychange` → hidden, which covers a
  tab that is switched away or backgrounded (measured: the write lands within
  50ms). A tab closed or reloaded inside the window still loses the edit,
  on main as before; closing that means writing at once and committing
  later, not a better signal. That is the named follow-up.
- `StorageHealth`'s threshold is a ceiling on an IndexedDB write that lands
  in tens of milliseconds behind a 500ms debounce. Five seconds is not a slow
  write; it is a write that is not happening.
- A page that mounts already unsaved counts from the mount, and a pending
  state with no known start is `ok`: the judgement never opens on a
  condition it did not see begin.
- The version dot's question ("edits no named version holds yet") has no
  carrier in chrome. The History panel answers it.
