# Report a gesture problem

When a touch or drag on the canvas misbehaves — a press that does not pan, a pinch that jumps —
the app has already recorded what happened. The editor keeps a rolling record of the last ~200
pointer events and what the canvas decided for each one, so you do not need to reproduce the
problem on demand or attach a debugger to your phone.

## Copy the trace

1. Right after the misbehaving gesture, open **Settings**.
2. Find **Gesture diagnostics** (under the app section, next to *App version*).
3. Tap **Copy trace**.

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

The canvas's gesture decisions are made by a pure function over these events, so a pasted trace
can be replayed exactly, away from your device — including whether a press ever reached the
editor at all, or was consumed by another element in front of it.
