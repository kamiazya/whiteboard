# Connect the web app to a local daemon

The web app (`apps/web`) can run entirely in the browser with no daemon —
documents are stored in IndexedDB and never leave the device. This guide
covers connecting it to a local daemon (started with `whiteboard daemon run`),
and moving a workspace kept in your browser onto it.

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

## When the daemon cannot be stopped or started

`whiteboard daemon status --json` says what the CLI makes of the daemon's
record (`daemon.json` in the data directory), in its `reason` field.
`whiteboard daemon doctor --json` reaches the same verdict and words it as a
finding with a remediation. `whiteboard daemon stop --json` and
`whiteboard daemon run` read the record the same way.

| `reason` | What it means | What to do |
|---|---|---|
| `null` (`ok: true`) | The daemon the record names is running. | Nothing. |
| `record-not-found` | There is no record: no daemon is running on this data directory. | `whiteboard daemon run` |
| `process-not-running` | The record names a process that has exited. | `whiteboard daemon run` starts over the record. `daemon stop` removes it. |
| `pid-reused` | The record's pid now belongs to a process that started after the record was written, and nothing accepts a connection on the record's socket. The daemon has gone. | `whiteboard daemon run` starts over the record. `daemon stop` removes it and signals nothing. |
| `identity-unconfirmed` | The record's pid looks like a later process, but something serves the record's socket and does not confirm that pid. It either answers as another process, or accepts the connection and gives no answer within 1.5 seconds. When the answer named its pid, `servingPid` gives it. | Stop the process serving the socket, then `whiteboard daemon run`. Use `servingPid` when it is present. Otherwise, find the socket's owner with `ss -xlp` or `lsof`. `daemon stop` refuses here: it signals nothing and keeps the record. |
| `record-token-missing` | The record has no token. When `pidAlive` is `true`, something still holds the record and this record cannot reach it. When `pidAlive` is `false`, the daemon has gone. | If `pidAlive` is `true`, stop that daemon with the build that started it. Otherwise, `whiteboard daemon run`. |
| `record-other-version` | This build cannot interpret the record, and the daemon it names is still there. Most likely, a daemon of another version wrote it. `record.version` gives that version when it can be read. | Stop that daemon with the version that started it, then `whiteboard daemon run`. Do **not** remove `daemon.json`: that daemon would keep serving with no record, so no build could stop it. `daemon run` would then fail on its socket. |
| `record-unreadable` | The record could not be read at all, so nothing is known of the daemon it may name. Most often the data directory is writable by other users or is a symlink, or `daemon.json` is a symlink, has another hard link, or belongs to another user. `recordFound` says whether a `daemon.json` is there. `daemon doctor` gives the exact cause in the finding's `detail`. | Fix what `detail` names, for example `chmod 700` on the data directory, then run `whiteboard daemon status` again. Do **not** remove `daemon.json`: the daemon it names may still be serving. |
| `record-malformed` | The record names no daemon, or this build cannot interpret it and the daemon it names has gone. | Remove `daemon.json`, then `whiteboard daemon run`. |

`pidAlive` means the same under every `reason` that carries it: `true` when
something may still hold the record, because the daemon it names is running or
something serves the record's socket. It is `false` when that process has
exited, and under `pid-reused`, where another process has the pid but nothing
serves the socket.

For `record-other-version`, and for `record-token-missing` while `pidAlive`
is `true`, `daemon stop` and `daemon run` print no JSON. They exit `1` with
one line on stderr that names the record file and says what is still running.
They do the same for `record-unreadable`, naming the cause. Over a
`record-malformed` record, `daemon stop` reports
`record-not-found`, and `daemon run` starts and writes a new record in its
place.

`daemon stop --json` reports its own outcome in `action` and `reason`:

- `stopped` (`reason: null`): the daemon exited and its record was removed.
- `not-running`, with `record-not-found`, `process-not-running` or
  `pid-reused`: there was nothing to stop. A record that outlived its daemon
  is removed.
- `refused`, with `identity-unconfirmed`: see the table above. The result
  carries `servingPid` when the process serving the socket named itself.
- `refused`, with `kill-failed`: the stop signal could not be sent to the
  recorded pid, for example because another user owns that process. Nothing
  else was changed.

## Collect a support bundle

`whiteboard daemon support-bundle` writes the daemon's `status` and `doctor`
results to a folder as redacted JSON, for attaching to a bug report. It reads
the record and runs the checks only; it does not start, stop or signal the
daemon.

```sh
whiteboard daemon support-bundle --json --output-dir=./whiteboard-bundle
# Another data directory than the default:
whiteboard daemon support-bundle --json --output-dir=./whiteboard-bundle --data-dir=<path>
```

| File | Content |
|------|---------|
| `status.json` | What `daemon status --json` reports: `ok`, `reason`, `recordFound`, `recordFresh`, `pidAlive`, and the record's `pid`, `version` and `startedAt` |
| `doctor.json` | Every `daemon doctor --json` check: `id`, `status`, `summary`, `detail` and `remediation` |
| `manifest.json` | `createdAt`, `packageVersion`, `platform` (OS and Node version), `mode` (`daemon`), and the sections above. Written last, so every file it lists is already there |

What the bundle never contains:

- The record's token, or any `Authorization`/`Bearer` value.
- Document content, uploaded files, or the input and output of MCP tool calls.
- Absolute paths in the check text: each one is replaced with
  `[REDACTED_PATH]`, so the data directory is not named.
- Log lines. The daemon writes its log records to stderr and keeps no log file.

The output folder may be missing, in which case it is created, or empty. The
command refuses any other folder and writes nothing:

- A folder that is not empty: `Could not write support bundle. The output
  directory must be empty.`
- A path that is a file or itself a symlink, or that passes through a symlink
  in a folder someone else could have placed it in: `Could not write support
  bundle. The output path must be a real directory, not reached through a
  symlink in a folder other users can write.` A symlink is followed when the
  folder holding it is owned by you or root and is not group- or
  other-writable, so macOS's `/tmp` (a link to `/private/tmp`) is fine. On
  Windows every symlink in the path is refused.

On success, stdout is one JSON line,
`{"schemaVersion":1,"ok":true,"outputDir":"<absolute path>","files":["status.json","doctor.json","manifest.json"]}`,
and the exit code is `0`. On any failure, stdout is empty, stderr carries one
line that names no path, and the exit code is `1`. Nothing already written is
removed.

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

The move carries your documents and their edit history, the **Trash**
(so a trashed document can still be restored on the daemon), every **saved
version** with its label, and every image any of these use — including an
image only a trashed document or an older version shows. Documents keep
their identity, so links between them keep working on the daemon. If a
path already exists in the chosen daemon workspace, both versions are kept
and the pre-existing one is marked *shadowed* — nothing is renamed or
overwritten. Your saved versions keep their dates; the move adds one more,
marking the move itself.

The move is one request of at most 24 MiB, and the Trash is what gives
way: once the workspace, its saved versions and the trashed documents taken
so far reach that limit, each further trashed document stays behind. The
limit is on the total, so many medium-sized trashed documents reach it as
surely as one large one, and moving again leaves the same ones behind —
empty the Trash of what you no longer need to let the rest go. Anything
this browser cannot read stays behind too. The result names each one when
the move finishes, and the browser copy is kept so nothing is lost.

One move carries at most 2000 documents, the most a browser keeps on a
desktop. The daemon refuses a larger workspace whole, with the error
`promote_too_many_documents`, and keeps none of it. The same 2000 is the most
a daemon workspace holds, so a move into a workspace that already holds
documents is refused, with `too_many_documents`, when the two together would
hold more — and at 2000 the daemon refuses any new document, however it is
added, with the same error.

A saved version is held to the same limits as the documents themselves: a
move whose saved versions include one with a body, node text or board past
its limit is refused whole, under the error a sync write past that limit
gets (for example `markdown_too_large`), and keeps none of it.

Once the daemon confirms it holds every document, image, trashed document
and saved version that moved, the old browser copy is removed — its Trash
and saved versions with it: the daemon is the workspace's one keeper, and this browser
keeps a **cached replica** instead — it stays editable when the daemon
cannot be reached, and your edits reach the daemon when it returns. The replica holds
the images its documents show too, up to 64 MiB per workspace; an image past
that limit, or one the daemon could not serve when the replica last synced,
reads *Image unavailable offline* until a later sync can fetch it. What the
replica shows depends on what is actually on this device and what the daemon
last said: a copy that is readable in memory, a copy that only your passkey
can open (with an **Unlock with your passkey** action that needs no
network), or a copy that is present but locked until the daemon can be
reached again (with a Reconnect action). Another tab that was showing the
moved workspace switches to a workspace this browser still keeps, and says
the workspace moved to the daemon.

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
anywhere, and the way to let go of it is to move it to a daemon first. A copy
open in another tab when you delete it locks there and says it was deleted,
so nothing typed in that tab can write it back.

## Read a copy offline

A cached replica, the images it holds included, is encrypted on this device,
and its key is held only while the tab is open. To open a copy after the tab
has closed and the daemon is unreachable, use **Make readable offline** on
its row in **Settings > Connections > Copies on this device**.

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
