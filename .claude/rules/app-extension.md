---
paths:
  - "apps/extension/**"
---

# apps/extension — the whiteboard browser extension

ADR-0050 decision 1: the hosted app reaches the local daemon only through this
extension, which relays each page connection to one native messaging host
process (`whiteboard native-host run`, in `packages/mcp-server`), which relays
to the daemon's owner-only socket.

## What it is allowed to do, and why so little

- **It reads no message.** It pairs a page port with a native port and passes
  messages both ways. The host validates what the page asks for
  (`pageToHostSchema`) and attaches the daemon's credential itself, so the
  extension carries no validator and no secret — keeping zod out of the
  service worker took it from 140 kB to 3 kB.
- **Its one check is who may connect**: `externally_connectable.matches`,
  which Chromium enforces, and `admitsOrigin` over the same list, read back
  from the build's own manifest. A match pattern names no port, so neither
  does the comparison.
- **The production build admits the hosted app alone.** A loopback page can be
  served by any user of the machine, and a preview deployment is built from
  anybody's pull request, so `localhost`/`127.0.0.1` exist only in the
  development build and previews in neither. `manifest.test.ts` pins both.

## The id is fixed by a key

`manifest.ts` carries the PUBLIC half of an RSA key; Chromium derives the
extension id from it, and the native host's manifest allows exactly that id
(`WHITEBOARD_EXTENSION_ID`, daemon-client's `extension-names`).
`manifest.test.ts` derives the id from the key, so the two cannot drift. The
private half is not kept: releases are loaded by hand while 0.0.x (ADR-0050
addendum decision 5), and a store signs what it publishes.

## Build, load, and the smoke

- `pnpm --filter @kamiazya/whiteboard-extension build` writes
  `dist/production` and `dist/development`, each the directory Chromium's
  "Load unpacked" takes.
- `whiteboard native-host install --json` registers the host with each
  installed Chromium browser (a launcher under the data dir, a manifest per
  browser).
- `smoke:bridge` is the real-browser proof: a real daemon, the real host, the
  built extension and headless Chromium — and the built web app connecting
  from a browser-kept document, reading an agent's note and writing back. Branded Chrome ignores
  `--load-extension`, so it needs Playwright's own Chromium
  (`pnpm exec playwright install chromium`).

## Tests

Vitest project `extension-node`: the manifest and the relay, the relay over a
fake `chrome` that implements only the `ExtensionApi` interface it declares
(no `@types/chrome`).
