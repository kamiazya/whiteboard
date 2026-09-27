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
  from the build's own manifest (`admittedMatches`). A match pattern names no
  port, so neither does the comparison.
- **Firefox lets no page message an extension**, so its build
  (`firefoxManifestFor`) injects a content script (`page-relay.ts`) into the
  same pages instead. It carries messages between the page's window and the
  background relay for ports the page names, and reads nothing it carries.
  The relay admits a content-script port by the URL of the page it runs in.
  Firefox says why a port closed on `port.error`, not `runtime.lastError`,
  and the relay reads both.
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
  "Load unpacked" takes, and `dist/firefox-production`/`dist/firefox-development`,
  whose `manifest.json` Firefox's "Load Temporary Add-on" takes. The content
  script is built separately as a classic script (`closeBundle` in
  `vite.config.ts`): Firefox runs no content script as a module.
- `whiteboard native-host install --json` registers the host with each
  installed browser (a launcher under the data dir, a manifest per browser).
  Each engine's manifest carries only its own allow-list key: Firefox answers
  "No such native application" for a manifest that also has Chromium's
  `allowed_origins` — measured, and why the manifest is per engine.
- `smoke:bridge` is the real-browser proof: a real daemon, the real host, the
  built extension and headless Chromium — and the built web app connecting
  from a browser-kept document, reading an agent's note, writing back, and
  seeing the agent's next edit arrive live over SSE. Branded Chrome ignores
  `--load-extension`, so it needs Playwright's own Chromium
  (`pnpm exec playwright install chromium`).
- `smoke:bridge:firefox` is the same proof in Firefox, driven over WebDriver
  because Playwright cannot load an extension there. Not the snap Firefox:
  its native messaging asks a person through a desktop portal first. Both
  smokes share `smoke-kit.mjs` (daemon, web app, agent calls).

## Tests

Vitest project `extension-node`: the manifest, the relay and the content
script's page relay, over fakes that implement only the interfaces they declare
(`ExtensionApi`, `ContentScriptApi`, `PageWindow`; no `@types/chrome`).
