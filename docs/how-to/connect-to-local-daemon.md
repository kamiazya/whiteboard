# Connect the web app to a local daemon

The web app (`apps/web`) can run entirely in the browser with no daemon —
documents are stored in IndexedDB and never leave the device. This guide
covers connecting it to a local daemon (started with `whiteboard daemon run`),
and moving a workspace kept in your browser onto it.

The web app UI calls these "variations" and "combining changes," but the
underlying MCP tools your AI agent calls keep their own names — the UI
vocabulary is a presentation-layer choice and does not change the tool
contract.

## How the app reaches the daemon

The hosted app reaches a local daemon only through the **whiteboard browser
extension** ([ADR-0050](../contributing/adr/0050-local-daemon-trust.md)):

1. The page asks the extension.
2. The extension starts a small **native messaging host** — a program the
   `whiteboard` command registers with your browser.
3. The host relays the request to the daemon over the daemon's owner-only
   local socket, and adds the daemon's credential itself.

The daemon listens on **no network port**. On Linux and macOS it listens on
a Unix socket in your per-user runtime directory (`$XDG_RUNTIME_DIR/whiteboard/`,
or a `whiteboard-<uid>` directory under the system temp directory), readable
by you alone. On Windows it listens on a named pipe whose name is random per
start. Its record in the data directory (`daemon.json`, owner-only) says
where; the CLI, the stdio MCP entry and the native host all read it there.

The browser starts the native host only for the extension its manifest
names, so no web page and no other extension can take its place. A page
never talks to the daemon over HTTP, and the daemon serves no page of its
own.

**Without the extension**, the hosted app keeps its data in the browser, and
says that the extension is what connects it to a local daemon.

Running `whiteboard daemon run` interactively prints one line saying the
daemon is up (its pid and socket) and opens the hosted app in your
default browser once the daemon is listening. A script that needs to read
that line passes `--json`, which prints it as one JSON object instead. Pass `--no-open` (or set
`openBrowser: false` in a
[config file](../reference/configuration.md#config-file-local-daemon)) to
disable this. See
[Auto-opening the browser](../reference/configuration.md#auto-opening-the-browser-whiteboard-daemon-run)
for the conditions under which it is suppressed (CI, containers,
non-interactive shells).

A daemon that receives no request for 15 minutes stops on its own, unless a
page is still connected to it: an open tab keeps it running however long
nobody types. `whiteboard daemon run` then prints `whiteboard daemon stopped:
no request within its idle timeout.` to stderr and exits `0`; run it again to
continue.

After you upgrade `whiteboard`, a daemon that was already running keeps the old
build. `whiteboard daemon doctor --json` reports a `daemon.version` check as a
warning (the overall status is `warning` and the exit code stays `0`) when the
version in the daemon's record differs from the build you are running, and
points at `whiteboard daemon stop --json`. Stop it and start it again to pick
up the new one.

## Get the `whiteboard` command

Every `whiteboard ...` command on this page is the CLI that
`@kamiazya/whiteboard-mcp` ships; the package's one executable is
`whiteboard`. Install it once so the command is on your `PATH`:

```bash
npm install -g @kamiazya/whiteboard-mcp
```

Without installing, `npx -y @kamiazya/whiteboard-mcp daemon run` runs any of
them (the arguments after the package name are the command's own). That is
fine for starting the daemon, but not for step 3 below: `native-host install`
records the path of the `whiteboard` it ran from, and the copy `npx` unpacks
is in a cache directory it replaces on the next release. Run that step from
the global install; the command warns on stderr when it finds itself in
`npx`'s cache.

## Set it up

While releases are `0.0.x`, the extension is not published to any store; you
load it by hand.

### 1. Build the extension

From a checkout of this repository:

```bash
pnpm install
pnpm --filter @kamiazya/whiteboard-extension build
```

This writes one build per engine under `apps/extension/dist/`:
`production` (Chrome, Edge and other Chromium browsers) and
`firefox-production` (Firefox). The `development` builds additionally admit
a `localhost` page, for working on the web app itself.

### 2. Load it into your browser

- **Chrome, Edge, Brave, Chromium:** open the extensions page
  (`chrome://extensions`, `edge://extensions`), turn on **Developer mode**,
  choose **Load unpacked**, and pick `apps/extension/dist/production`.
- **Firefox:** open `about:debugging#/runtime/this-firefox`, choose **Load
  Temporary Add-on…**, and pick `manifest.json` inside
  `apps/extension/dist/firefox-production`. A temporary add-on is removed
  when Firefox closes, so load it again after a restart.
- **Safari:** not yet. Safari's extension ships inside a macOS app, which is
  a later stage; in Safari the app keeps its data in the browser.

### 3. Register the native host

```bash
whiteboard native-host install --json
```

This needs no administrator rights: it writes the host's manifest at user
level, naming only the whiteboard extension as allowed to start it, plus a
small launcher that records which Node, which `whiteboard` install and which
data directory the host relays to. Pass `--data-dir=<path>` if your daemon
uses a data directory other than the default. Run it again after moving or
reinstalling `whiteboard`, including when a new release replaces the copy it
ran from.

Where the manifest goes depends on the platform:

- **Linux:** into each installed browser's user directory — Chrome
  (`~/.config/google-chrome/NativeMessagingHosts`), Chromium, Edge, Brave,
  Firefox (`~/.mozilla/native-messaging-hosts`) and the Snap Firefox
  (`~/snap/firefox/common/.mozilla/native-messaging-hosts`). A browser whose
  directory does not exist yet is skipped; start it once, then run `install`
  again.
- **macOS:** into each installed browser's directory under
  `~/Library/Application Support/` (Chrome, Chromium, Edge, Brave, and
  Firefox's `Mozilla/NativeMessagingHosts`).
- **Windows:** the manifests are kept under the data directory, and a
  per-user registry key names each one (`HKCU\Software\Google\Chrome\NativeMessagingHosts`,
  and the Chromium, Edge and Mozilla equivalents). Every one is registered,
  whether or not that browser is installed.

`--manifest-dir=<path>` and `--firefox-manifest-dir=<path>` write to one
directory of your choosing instead.

**Snap Firefox on Ubuntu asks you once.** Its native messaging goes through
a desktop portal, and the first time the extension starts the host Firefox
shows a permission prompt. Setup never grants it for you. If you refused
and want to be asked again, remove the stored answer with
`flatpak permission-remove webextensions io.github.kamiazya.whiteboard snap.firefox`
(the `flatpak` command manages the portal's permission store even without
any Flatpak apps), or reset every portal permission Firefox holds with
`flatpak permission-reset snap.firefox`.

### 4. Connect

Start the daemon with `whiteboard daemon run`,
then in the hosted app open the workspace popover and choose **Connect
through the extension**. The app reloads onto the daemon's workspaces.

## Move this workspace to the daemon

A browser can keep only so many documents in one workspace, because the
whole workspace lives in the tab's memory. On a desktop the limit is 2,000
documents, and on a phone or tablet (or a device reporting 4 GB of memory or
less) it is 500. From 1,400 documents (300 on a phone) the document list
suggests moving the workspace. At the limit, creating or duplicating
another document is refused with that same suggestion. Editing
the documents you already have keeps working
([ADR-0044](../contributing/adr/0044-workspace-capacity.md)).

Once a daemon is connected, you can move everything this browser keeps in
one step from **Settings → Connections → This workspace**:

1. Open **Settings → Connections** and find the **This workspace** section.
2. Click **Move to daemon…**, choose the daemon workspace to move into, and
   confirm.
3. When the move finishes, the result stays visible in that section. Use
   **Reload and continue from the daemon** to switch to working from the
   daemon, or keep working in the browser.

The move carries your documents, their full edit history, and the images
they reference. Documents keep their identity, so links between them keep
working on the daemon. If a path already exists in the chosen daemon
workspace, both versions are kept and the pre-existing one is marked
*shadowed* — nothing is renamed or overwritten.

Once every document and image is confirmed on the daemon, the old browser
copy is removed: the daemon is the workspace's one keeper, and this browser
keeps a **cached replica** instead — it opens read-only when the daemon
cannot be reached, so your data stays viewable offline. What it shows
depends on what is actually on this device and what the daemon last said:
a copy that is readable in memory, a copy that only your passkey can open
(with an **Unlock with your passkey** action that needs no network), or a
copy that is present but locked until the daemon can be reached again (with
a Reconnect action).

The passkey unlock is what lets a copy survive closing the tab, and you
switch it on per copy: see
[Read a copy offline](#read-a-copy-offline) below. Until you do, a copy
stays readable only until the tab closes. If anything could
not be confirmed (for example an image upload failed), the browser copy is
kept unchanged and the result says so, naming why. The daemon stores PNG,
JPEG, GIF, WebP and SVG images up to 16 MiB each, so an image of another type
or size stays behind until you replace it; a dropped connection is cured by
moving again, which is safe and simply re-merges.

## See and remove the copies this device keeps

**Settings > Connections > Copies on this device** lists every copy of a
workspace this browser holds: the ones it keeps itself, and the cached
replicas of daemon workspaces. A replica row says which daemon it came from
and when it last synced, and offers **Delete copy**.

Removing a cached copy is housekeeping rather than a change of access — the
daemon still keeps the workspace, and this device can cache it again. What
does not come back is anything in that copy which had not reached the daemon
yet, so the confirmation says so before you commit to it. The copy the
session is currently showing is not offered a delete, and neither is a
workspace this browser keeps itself: that one is the only copy of its data
anywhere, and the way to let go of it is to move it to a daemon first.

## Read a copy offline

A cached replica is encrypted on this device, and its key is held only while
the tab is open. To open a copy after the tab has closed and the daemon is
unreachable, use **Make readable offline** on its row in **Settings >
Connections > Copies on this device**.

The action creates a passkey in this browser only. It is not registered with
the daemon, and the app never asks for one on its own. The copy's key is
locked with that passkey, and the row then reads *Readable offline with your
passkey.* The next time the daemon cannot be reached, the copy offers
**Unlock with your passkey**: one gesture, no network.

- The action works only while the daemon that keeps the workspace is
  connected, because its key is needed to lock the copy. Otherwise the row
  says so and the button is disabled.
- **If you lose that passkey, this device's copy cannot be read again.** The
  daemon still keeps the workspace, so a fresh copy can be pulled; anything
  this device had not yet sent is gone.
- A browser whose passkeys cannot do this says *This browser cannot make a
  copy readable offline.* and nothing is changed.
- **Turn off** on the row removes the locked key, so the copy is again
  readable only while a tab holds it. The passkey stays in your passkey
  manager; delete it there if you no longer want it.

## See what this device keeps of a daemon-kept workspace

Once a workspace is kept by a daemon, **Settings → Connections → This
workspace** shows a short line describing what this device keeps of it,
below the move description:

- *Needs a connection. No copy is kept on this device.* — nothing is stored
  here; the workspace is unreadable while the daemon is unreachable.
- *A copy is kept on this device while this tab stays open.* — an offline
  copy is kept, readable while the daemon is unreachable, for the current
  session.
- *A copy is kept on this device for a limited time.* — an offline copy is
  kept, readable until it expires.

This line is read-only status; nothing on this screen changes it — the
workspace's offline policy is set by the daemon operator (see
[security model → Replica key](../explanation/security-model.md#replica-key-offline-read-plane)
for what each policy means and how it is set today).

← Back to [How-to guides](README.md)
