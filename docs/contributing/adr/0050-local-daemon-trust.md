# ADR-0050: The local daemon proves itself to its clients, and pairing is approved by whoever controls its data

**Status:** Proposed — the owner took decisions 2 and 6 on 2026-09-26, after
an audit of how the local daemon's clients find and trust it. Decision 2
was revised the same day, after a security review showed that a cookie or a
URL cannot carry the approval (see its alternatives). Nothing is built.
Numbered 0050 because ADR-0049 is open alongside it.

## Context

The local daemon listens on a loopback port. A browser pairs with it, an MCP
proxy talks to it, and the CLI manages it. All of them find it by port
number. Asked whether that survives a **port-swapping** attack — another
process taking the port and posing as the daemon — the audit found that
problem and a worse one.

### Measured: the pairing page hands out the daemon's token

The daemon serves its own pairing consent page at `/pair` to anyone, and
writes its full-authority token into that page, so that pressing Approve can
persist a grant.

Tested on 2026-09-26 against a production build with a fresh data directory:
- A plain request for `/pair` returned the 32-character token, identical to
  the one in the daemon's owner-only (0600) record file.
- The token then authorised the API: 200 with it, 401 without.
- `/pair` also answered a forged `Host` header, so a DNS-rebinding page can
  read the token. The API and `/mcp` refuse a foreign `Host` even with the
  token, so such a page cannot use it through the browser.

So the file permission that guards the token is undone by the port. Any
process on the machine, under any OS user, can read the token without taking
over anything.

### Found by reading the code, not yet reproduced

- **A relay defeats the pinned key.**
  - The daemon exits after 15 minutes idle.
  - When its port is taken on the next start, it silently moves to the next
    free one, while browsers keep using the stored port.
  - A squatter on the old port can relay the browser's renewal to the real
    daemon, forging the `Origin` header, which only a browser cannot forge. It
    receives a real session token and a valid signature over the renewal.
    The pinned-key check then passes, and the squatter sits in the middle of
    all traffic.
- **Renewal trusts an `Origin` header.** A session token is minted for any
  caller naming an origin that holds a grant. A browser cannot forge
  `Origin`, but any other process can. So another OS user can mint a
  session token without taking over the port at all, and then use it on the
  API, WebSocket and SSE.
- **The pin can be replaced.** When the key does not match, the app sends
  the person to approve pairing again. That page belongs to whoever holds the
  port, and approving overwrites the pinned key. A browser with no pin is
  taken over without any warning.
- **Identity is checked only at renewal.** WebSocket and SSE connections
  reconnect to whatever holds the port, so after a restart an open tab can
  receive forged document updates and sync them to the real daemon.
- **The development lane trusts any responder.** The dev hook takes anything
  that answers on the derived port with JSON as the daemon, and the proxy
  sends the public dev token. A squatter's forged tool results become prompt
  injection for the agent.
- **The temporary-directory fallback** for the data directory checks
  permission bits, not the owner. Another user who creates that directory
  first controls the daemon's record.

### Already holding

- A second process cannot bind a port the daemon holds.
- The record and identity key files are owner-only, and the daemon refuses to
  start on a readable secret.
- Pairing session tokens live only in memory, so they die with the daemon.
- A passkey challenge is minted by the daemon and single-use.
- The packaged stdio MCP server opens no socket at all.

## Decision

1. **The threat model is other OS users, whoever holds the port, and web
   pages. It is not code running as the daemon's own user.** Code running as
   the owning user can read the daemon's owner-only files and needs no
   network trick. Nothing here claims to stop it. Every other party must be
   unable to obtain a credential, pose as the daemon, or sit between the
   daemon and its clients.

2. **Pairing is approved in the CLI, by whoever controls the daemon's
   data.**
   - The pairing page carries no secret. It files a pending request with the
     daemon (the origin asking, and a short matching phrase) and shows the
     phrase.
   - `whiteboard daemon pair` lists pending requests with their origin and
     phrase. When the person confirms the one they see in the browser, the
     CLI approves it, authenticating with the token in the owner-only
     record. The page then completes the pairing.
   - The CLI checks the daemon's key against the owner-only record before it
     sends that token, so it never hands the token to whoever holds the port.

   What follows:
   - No secret ever travels in a URL, a cookie, a command's arguments, or a
     page. The token stays between the record and the CLI.
   - Pending requests expire quickly and are capped, because anyone can file
     one. Filing one grants nothing; only the CLI's approval does.
   - It works unchanged for a daemon running as a service. The approver only
     has to be able to read the daemon's record: the same user for a
     per-user service, an administrator for a system one. That is the
     intended boundary.
   - The receive-transfer page, which also reads the injected token today,
     moves to the same approval.

3. **Every page and route the daemon serves checks `Host`.** The `/api` and
   `/mcp` guard is extended to the pairing page and its assets, so a
   rebinding page reads nothing.

4. **Renewal proves the browser, not an `Origin` header.**
   - At pairing, the browser makes a key that cannot be exported and
     registers its public half with the grant.
   - Renewing a session token means signing a nonce from the daemon with
     that key. A process that is not that browser profile cannot sign, so it
     cannot mint a token, whatever `Origin` it sends.

5. **The daemon proves itself on the connection it is reached over.**
   - The signature a client checks covers the daemon's own origin (scheme,
     host and bound port) as well as the client's nonce and origin. A client
     refuses a proof for any origin other than the one it connected to, which
     defeats a relay to a daemon on another port.
   - Clients check the proof before every WebSocket or SSE reconnect and
     whenever the configured address changes, not only at renewal.
   - A pinned key is never replaced silently. A different key is only
     accepted through the approval in decision 2, which a squatter cannot
     complete.
   - `whiteboard daemon status` prints the key's fingerprint, so the pairing
     page's fingerprint can be checked against something the squatter does
     not control.

6. **The daemon does not start on a port it did not ask for.** If the default
   port is taken, it exits with an error naming the port and, where it can,
   the holder. Another port is used only when it is given explicitly. Moving
   silently is what sends browsers to a squatter.

7. **The development lane gets a secret and a check.**
   - Each worktree's owner-only marker holds a random token, which replaces
     the public dev token.
   - The hook and the proxy verify the daemon's key before trusting a
     responder. A responder without a marker is not treated as healthy.

8. **The data directory must be owned by the user running the daemon.** The
   secret-file check compares the owner as well as the permission bits, and a
   directory someone else created is refused rather than adopted.

## Consequences

- **Pairing gains a step in the terminal.** A person who starts from the web
  app is told to run `whiteboard daemon pair` and confirm the phrase. The
  page waits and completes on its own.
- **Pairing needs the CLI**, which is always installed where the daemon
  runs.
- **Clients do one more exchange** per reconnect. It is one signature check,
  and reconnects are rare.
- **Starting the daemon can fail where it used to move.** The error says what
  holds the port, so the fix is visible.
- **The token exposure and `Origin`-only renewal are live today.** Decisions
  2, 3 and 4 close them and should land first, ahead of the rest.

## Alternatives considered

- **A one-time code the CLI opens in the browser, exchanged for a cookie.**
  The owner's first choice, withdrawn after review. A cookie for `127.0.0.1`
  is sent to every port on that host, so a squatter on another port receives
  it. A code in the URL passes through the browser-opening command's
  arguments, which other users can read, as well as history and `Referer`.
- **A long code the CLI prints, pasted into the page.** No secret in a URL,
  but the page it is pasted into may be the squatter's, which then holds a
  working code. Approving in the CLI means the secret never meets a page.
- **A code shown by the daemon, typed into the page.** Close to today's flow,
  but a short code needs attempt limits to resist guessing, and a daemon
  running as a service has no terminal to show it on. The CLI obtaining the
  code covers both: the code can be long, and any user who can read the
  record can ask for one.
- **Keep the token in the page and rely on `Host` and CORS.** That closes the
  web-page path only. Any local process still reads it, which is the finding.
- **Move to the next free port and announce it loudly.** Keeps starts working,
  but browsers that saved the old address keep reaching the squatter, and
  only decision 5's origin binding would stand between them.
- **Loopback TLS with the pinned key as the certificate.** Binds identity to
  the connection most completely, but a browser will not accept a
  self-signed loopback certificate without the person installing it. Decision
  5 gets the same binding at the application layer.
