# ADR-0050: A hosted page reaches the local daemon through a browser extension, never over loopback HTTP

**Status:** Proposed. The owner chose the extension route on 2026-09-26,
after three steps: an audit, a survey of how comparable products are built,
and a measured spike. Nothing is built.

This ADR supersedes three earlier decisions:
- [ADR-0002](0002-browser-to-daemon-transport.md)'s choice of loopback HTTP
  and WebSocket as the browser-to-daemon transport;
- [ADR-0005](0005-hosted-origin-authorization.md) decision 2, the daemon as
  an authorization server for the hosted origin;
- ADR-0005 decision 3, the pairing link.

Numbered 0050 because ADR-0049 is open alongside it.

## Context

ADR-0005 made one premise non-negotiable: open the familiar hosted URL, and
keep the data on your own machine. It built that on the most obvious
transport, a hosted page calling the daemon's loopback port. An audit asked
whether that survives a **port-swapping** attack, where another process takes
the port and poses as the daemon. It found that problem and a worse one.

### What the audit found

**Measured on a production build:** the pairing page served the daemon's
full-authority token to any caller.
- A plain request for `/pair` returned the token that the owner-only (0600)
  record file protects.
- That token then authorised the API.
- So any process on the machine, under any OS user, could read the token
  without taking over anything.

**Found by reading the code:**
- **Renewal trusts an `Origin` header.** A browser cannot forge one, but
  any other process can. So a session token could be minted for any origin
  that holds a grant.
- **A relay defeats the pinned daemon key.** When its port is taken, the
  daemon silently moves to the next free port, while browsers keep the old
  one. A squatter on the old port can then forward the browser's renewal to
  the real daemon and sit in the middle.
- **Identity is checked only at renewal.** A reconnect after a restart can
  reach whoever holds the port.
- **The first-use pin can be replaced** through the re-approval the app
  itself recommends.

### What comparable products do

The failures in this area belong to one shape: a web page reaching an HTTP
service on loopback, trusted by an `Origin` header, a port, or nothing.
- Zoom's 2019 local web server (CVE-2019-13450, CVE-2019-13567).
- Ollama's unauthenticated API (CVE-2024-37032).
- Figma's font helper.
- Node's inspector DNS-rebinding bypass (CVE-2021-22884).

Browser vendors treat the shape itself as a hazard. Chrome now asks
permission before a public page reaches loopback (Local Network Access).
Safari blocks it outright as mixed content, which is why ADR-0002 already
left Safari at browser storage only.

Products that hold up avoid the shape:
- **The UI is served from the daemon's own origin** (Jupyter, Syncthing,
  code-server). This gives up the hosted URL, which ADR-0005 and the owner
  both rejected.
- **Local IPC, where the OS identifies the caller** (Tailscale's LocalAPI,
  Docker's socket). A peer's user is checked by the kernel, not claimed in a
  header.
- **A browser extension bridging to a native process** (1Password,
  Bitwarden). The OS decides which extension may start which program, so
  there is nothing for a page or another process to forge.

### What the spike measured

Setup: a page, an extension, a native messaging host and a mock daemon over a
Unix socket, compared with today's loopback WebSocket.

| | round trip p50 / p95 | 1 MB | 5 MB |
|---|---|---|---|
| Chrome 153, WebSocket (today) | 0.2 / 0.3 ms | 15 ms | 78 ms |
| Chrome 153, extension | 0.3 / 0.5 ms | 38 ms | 199 ms |
| Firefox 156, WebSocket | 0 / 2 ms | 14 ms | 74 ms |
| Firefox 156, extension | 1 / 2 ms | 41 ms | 219 ms |

- **Edits are indistinguishable** from WebSocket. Bulk transfer is about three
  times slower, because of JSON, base64 and chunking, and that affects only
  a workspace's first load.
- **A busy workspace is small.** The development daemon holding this
  project's whole issue backlog is 2.9 MB of database, so first load costs
  roughly a fifth of a second more.
- **Chrome caps a message from the native program at 1 MB.** Chunking held
  up to 20 MB with no loss.
- **Firefox cannot message an extension from a page directly.** A content
  script relays, and costs little.
- **Ubuntu's snap Firefox works through the desktop portal after a one-time
  consent.** The portal asks whether Firefox may start the program and
  remembers the answer, including a refusal.
- **A Unix socket path is limited to 108 bytes,** so the socket cannot live
  under an arbitrary data directory.

## Decision

1. **The hosted page reaches the daemon only through the whiteboard
   browser extension.**
   - The page messages the extension: directly where the browser allows it
     (Chrome, Edge, Safari), and through a content script where it does not
     (Firefox).
   - The extension starts a small native messaging host, which relays to the
     daemon.
   - The browser starts that host only for the extension its manifest names,
     so no web page and no other process can take its place.
   - The page never calls the daemon over HTTP.

2. **The daemon listens on a local socket, not a browser-facing port.**
   - It listens on a Unix domain socket on Linux and macOS, and a named pipe
     on Windows, in the per-user runtime directory, owner-only.
   - Where the platform allows it, the daemon checks the peer's user through
     the kernel.
   - The native host, the CLI and the stdio MCP entry point all reach it
     there.
   - The socket path is short by construction, which avoids the 108-byte
     limit.

3. **Loopback HTTP is not served to browsers.**
   - The pairing page is removed, along with its token injection, pairing
     grants, the hosted-origin authorization server, `Origin`-based renewal
     and the pairing link.
   - A request carrying a browser `Origin` is refused outright on any
     loopback listener that remains.
   - A loopback HTTP listener may exist only for an MCP client that can
     speak nothing else. It is off by default, requires the owner-only token,
     and is documented as reachable by any process that holds its port.

4. **Without the extension, the hosted app keeps its data in the browser.**
   - Any browser without the extension installed is in that position.
   - The app says plainly that the extension connects it to a local daemon,
     rather than offering a connection that fails.

5. **Every major engine is a target: Chromium (Chrome, Edge), Firefox and
   Safari.**
   - This reverses ADR-0002's decision to leave Safari at browser storage
     only for the daemon connection. That decision followed from WebKit
     blocking a hosted page's loopback request, and the extension removes
     that request.
   - Safari's other gaps are separate decisions and stay where they are:
     passkeys are out of scope (ADR-0039), and SharedWorker is absent.
   - Holding the daemon connection in the extension should remove the
     page's need for a SharedWorker for that connection. That is to be
     verified, not assumed.

6. **How each engine is shipped:**
   - **Chrome and Edge:** through each browser's store. Chrome on Windows
     and macOS will not install or update an extension from anywhere else,
     outside enterprise policy.
   - **Firefox:** signed by Mozilla. It can be listed in Mozilla's store or
     self-hosted with its own update manifest, and both update
     automatically.
   - **Safari:** inside a macOS app. That app can go through the Mac App
     Store, or be Developer ID-signed and notarised and distributed directly
     (Safari 18.4 and later), in which case it updates through the app's own
     updater.
     - In Safari the extension does not start a stdio program. It messages
       the app extension it ships with, so that is where the relay to the
       daemon's socket lives: a second host implementation.
   - **Whether an item is listed publicly or not** is decided per product
     phase, not here. An unlisted item is still reviewed and still
     auto-updates, so the choice is about discoverability, not security.
   - **The native host's manifest** (Chromium, Firefox) is written by
     `whiteboard` itself at user level, needing no administrator rights. The
     OS then allows only the extension's own id to start it.

7. **Snap Firefox's consent is the person's to give.** Setup never
   pre-grants the portal's permission. The guide explains that Firefox will
   ask once, and how to undo a refusal: remove the portal's stored answer,
   or reset the app's permissions.

## Consequences

- **The audit's findings stop existing rather than being mitigated.**
  - The token leak goes with the pairing page.
  - `Origin` trust goes with renewal.
  - The relay and the reconnect gap go with the browser-facing port.
  - Another OS user cannot open an owner-only socket.
- **A large security surface is deleted.** That is the pairing and consent
  page, the authorization server, CORS and Local Network Access handling,
  and the identity-pinning ceremony, all of which ADR-0005 accepted as the
  price of its premise.
- **Using a local daemon now needs the extension,** one per engine. The
  project ships and maintains a Chromium build, a Firefox build and a Safari
  build, the last inside a macOS app with its own relay to the daemon.
- **The extension and native host become security-critical code.**
  - The host must accept messages only from its extension. The OS enforces
    this.
  - The extension must accept messages only from the hosted app's origins:
    Chrome's `externally_connectable` list, and the content script's own
    match list in Firefox.
  - Firefox's Manifest V3 makes a content script's host access something the
    person grants, and the extension has to ask for it.
- **First load of a workspace costs more:** about three times the WebSocket's
  bulk time, and a fraction of a second at today's sizes. Live editing is
  unchanged.
- **Live sync gains a hop.** The page talks to the extension, which talks to
  the host, which talks to the daemon. The daemon's live fan-out,
  subscriptions and reconnection move from WebSocket and SSE handling to the
  socket protocol.
- **Unmeasured, and needed before building:**
  - Safari: page to extension to the containing app to the socket, and
    whether the daemon connection then needs no SharedWorker;
  - Edge;
  - Windows (named pipe, registry-registered host) and macOS;
  - an MV3 service worker suspended with a native port open;
  - a real Loro snapshot;
  - store review of an extension that uses native messaging.

## Alternatives considered

- **Serve the web app from the daemon's own origin** (ADR-0047's server-mode
  shape, applied locally). It is the simplest secure option, and every
  daemon-to-browser feature keeps working unchanged. Rejected by the owner: it
  gives up the hosted app as the place people work, which is ADR-0005's
  premise and the product's.
- **Keep loopback HTTP and harden it.** The first draft of this ADR did that:
  CLI-approved pairing, a browser-held renewal key, and a daemon proof that
  covers its own port. It stays inside the shape the survey found failing,
  depends on each browser's loopback policy continuing to allow it, and keeps
  every piece of the surface this ADR deletes.
- **Carry the approval in a cookie or a URL.** A cookie for `127.0.0.1` is
  sent to every port on that host, so a squatter on another port receives
  it. A URL passes through the browser-opening command's arguments, which
  other users can read.
