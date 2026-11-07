# Export a canvas to PNG or SVG from the daemon

The web editor's Export menu renders in your browser. When you want the **daemon** to render a
canvas instead — from a script, a cron job, or a build step, with no browser open — call its
export routes. They write the file and answer where they put it.

There is no `whiteboard` command for this yet; the routes are the supported way in, and `curl`
is enough to drive them.

## Before you start

- A running daemon (`whiteboard daemon run`; see
  [connect-to-local-daemon](connect-to-local-daemon.md)).
- `curl` built with Unix-socket support (`curl --version` lists `UnixSockets`) and `jq`.
- The fonts your canvas needs installed on the daemon, or a PNG draws their characters as empty
  boxes — see [install-fonts-for-export](install-fonts-for-export.md).

The daemon listens on no network port. It serves an owner-only Unix socket, and authenticates
every route with a bearer token; both are in its record, `daemon.json` in the data directory
(`~/.whiteboard/`, or `$WHITEBOARD_DATA_DIR`):

```sh
RECORD="${WHITEBOARD_DATA_DIR:-$HOME/.whiteboard}/daemon.json"
SOCKET=$(jq -r .socketPath "$RECORD")
TOKEN=$(jq -r .token "$RECORD")
```

Treat the token as a password: anything holding it can read and change every workspace.

## Export a PNG

Address the canvas by its workspace and its document id. A fresh data directory has one
workspace, `default`; the workspace's listing names every document with its id and its path:

```sh
curl --unix-socket "$SOCKET" -H "Authorization: Bearer $TOKEN" \
  http://daemon/api/workspaces/default/documents
# {"documents":[{"documentId":"01ARZ3NDEKTSV4RRFFQ69G5FAV","path":"plans/architecture",...}]}

curl --unix-socket "$SOCKET" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"scale": 2}' \
  http://daemon/api/workspaces/default/documents/01ARZ3NDEKTSV4RRFFQ69G5FAV/export
```

The host name after `http://` is ignored; the socket decides where the request goes. The id
survives a rename, so a script that saved one keeps working after the canvas moves.

The answer says where the file went and what it could not draw:

```json
{ "filePath": "<data dir>/exports/…/architecture.png", "undrawable": [] }
```

The body is optional. What it takes:

| Field | Meaning |
|---|---|
| `scale` | Zoom factor, above 0 and at most 8. |
| `padding` | Pixels of margin on every side, 0–1024. |
| `theme` | `light` or `dark`, whatever the canvas is set to. |
| `style` | `clean` (the default), `document` for the theme the canvas names, or a theme id. |
| `outputPath` | Where to write the file instead of the exports directory. |
| `overwrite` | `true` to replace a file already at `outputPath`. |

## Export an SVG

The same request at `…/export-svg`, without `scale`. An SVG keeps its text as text, so characters
the daemon has no font for still read correctly in any viewer that has one.

```sh
curl --unix-socket "$SOCKET" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"style": "document"}' \
  http://daemon/api/workspaces/default/documents/01ARZ3NDEKTSV4RRFFQ69G5FAV/export-svg
```

## When it refuses

A refusal is JSON with a code to match on and a sentence to show:

```json
{ "error": "not_found", "message": "Document not found: default/plans/architecture" }
```

`404` means the workspace or the document is not there; `400` names the field that was wrong;
`401` means the token did not match the running daemon — read `daemon.json` again: unless you
gave it one, a daemon mints a new token each time it starts.

← Back to [How-to guides](README.md)
