---
name: auditing-workspaces
description: Audit Excalidraw workspaces and canvases to detect orphaned workspaces, tombstone-heavy canvases, and cache/disk mismatches. Use when workspaces are piling up, sync looks suspicious, or you want to check for stale artifacts before creating new canvases.
---

# auditing-workspaces

Call the whiteboard MCP `/api/debug` endpoint to inspect workspace, canvas, and cache state.
Use it to find old workspaces (`hasActivePort=false`) and canvases dominated by tombstones, then report them as cleanup candidates.

For the main drawing workflow, see the drawing-visuals skill in `skills/drawing-visuals/SKILL.md`.

---

## When To Use It

- When whiteboard has been in heavy use and `~/.whiteboard/` seems bloated
- When you want to verify mechanically that a canvas is probably unused
- When sync behavior looks suspicious and you want to compare cache vs disk state
- Before opening a new canvas, when you want to check for duplicate slugs

---

## Execution Flow

### Step 1: Find The Port For A Running Workspace

In `~/.whiteboard/{workspaceId}/.port`, line 1 is the port number and line 2 is the PID.
An active workspace has a `.port` file and a live PID.

```bash
# Quick check for running .port files
ls $HOME/.whiteboard/*/.port 2>/dev/null
```

If multiple workspaces are found, use the most recent one by mtime.

### Step 2: Fetch Raw Data From `/api/debug`

```bash
curl -s http://localhost:{PORT}/api/debug | jq .
```

Response shape:

```json
{
  "sessions": [
    {
      "workspaceId": "...",
      "hasActivePort": true,
      "canvases": [
        {
          "slug": "...",
          "totalElements": 42,
          "visibleElements": 30,
          "tombstones": 12,
          "cached": true
        }
      ]
    }
  ],
  "cache": { "size": 3, "keys": ["sess/slug"] }
}
```

### Step 3: Aggregate From An Audit Perspective

Check the following mechanically:

| Concern | Condition | Suggested Action |
| --- | --- | --- |
| dead workspace | `hasActivePort=false` and canvases are not empty | candidate for deleting `~/.whiteboard/{workspaceId}/` |
| tombstone-heavy canvas | `tombstones / totalElements >= 0.5` and `totalElements >= 10` | consider rebuilding with `canvas_clear` or re-saving from a fresh snapshot |
| empty canvas | `totalElements=0` | candidate for deletion |
| cache leak | present in `cache.keys` but its workspace has `hasActivePort=false` | usually fixed by process restart; report it |
| cache size | `cache.size > 20` | possible memory pressure; watch long-lived workspaces |

### Step 4: Write The Report

Keep the user-facing summary short and structured like this:

```text
## whiteboard audit report

Active: {N} workspace / {M} canvas
Old workspaces: {K} candidates
Tombstone-heavy: {slug count}
Empty: {slug count}

### Deletion candidates
- ~/.whiteboard/{workspaceId}/ ({reason})

### Needs review
- {workspaceId}/{slug}: tombstones {T}/{Total} -> consider canvas_clear
```

Do **not** delete anything automatically. Always confirm with the user before running `rm -rf`.

---

## Notes

- `/api/debug` is a local-only endpoint. It is unauthenticated, so do not expose it externally
- A canvas with `cached=true` is currently backed by an in-memory LoroDoc. `cached=false` means it was read from disk through `peekDoc` only and did not populate cache
- `tombstones` count soft-deleted elements. They are part of the CRDT model, so do not delete them directly. If they are a problem, `canvas_clear` and rebuild is the safe route
- Deleting all of `~/.whiteboard/` destroys all workspace history. Delete only dead workspaces selectively
- If the numbers look wrong, restart the whiteboard MCP server first so doc-cache and filesystem state can resync, then rerun the audit
