# Report a gesture problem

When a touch or drag on the canvas misbehaves — a press that does not pan, a pinch that jumps —
the app has already recorded what happened. The editor keeps a rolling record of the last ~200
pointer events and what the canvas decided for each one, so you do not need to reproduce the
problem on demand or attach a debugger to your phone.

## Copy the trace

1. Right after the misbehaving gesture, open **Settings**.
2. Open **Developer**.
3. Tap **Copy trace** under *Gesture diagnostics*.

The trace is now on your clipboard as JSON. Paste it into a bug report, an issue, or a chat with
whoever is investigating.

Do this soon after the problem: the record is a rolling window, and roughly 40–60 later
taps will push the interesting events out of it.

## What the trace contains

Event kinds, screen coordinates, the internal names of controls that were pressed, mode names
(such as `panning`), your browser's user-agent string, the running bundle's file name, and the
viewport size. It never contains document content — no text, no node data, no titles.

Nothing is sent anywhere by itself. The trace leaves your device only when you copy and share it.

## What an investigator can do with it

Each pointer entry records the element it landed on and whether it reached the editor at all, so
a trace shows a press consumed by another element in front of it. The canvas's gesture decisions
are also made by a pure function over these events, so a developer can replay a pasted trace in a
test to reproduce the decisions away from your device. The app has no screen or command that
replays a trace for you.

For a developer, the test reads the trace with `parseGestureTrace` and folds it with
`replayNavigation`, both from `apps/web/src/components/spatial-editor/gesture-trace.ts`:

```ts
const trace = parseGestureTrace(pastedText)
const modes = replayNavigation(trace.entries)
```

Each trace carries a `format` number. `parseGestureTrace` throws if the format is missing or is
not the one the current build reads, and also if an entry carries an event type or field the
current build does not know. A trace recorded by an older bundle is refused instead of being
replayed against events whose fields have since changed. If it is refused, ask for a fresh trace
from a device running the current deploy.
