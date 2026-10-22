# Review proposed changes and restore a version

Two safety nets sit beside every document: the **Proposals** panel, where changes a connected AI
agent wants to make wait for your decision, and **History**, where saved versions of the document
can be previewed and restored.

## Review a proposal

Proposals come only from a connected AI agent. There is no way to propose a change yourself: you
edit the document directly. When an agent works through `wb_body_edit` or `wb_canvas_edit`
without applying directly, its changes are stored as a proposal instead of changing the document,
and they wait in the Proposals panel (and on the document itself) until you adopt or dismiss them.

With no agent connected, or nothing pending, the panel reads "Nothing waiting". To connect an
agent, follow [Quick install](../../README.md#quick-install) in the repository README.

## Find a saved version

Open **History** to list the document's versions. Two kinds appear:

- **Bookmarks** you take with the bookmark button or `⌘/Ctrl+S`.
- **Automatic checkpoints**, saved about five minutes after you stop editing, while the document
  is open. Closing the tab inside that window saves the pending checkpoint as the page goes away;
  the browser treats that write as best-effort.

A document you have never edited for five minutes, or closed abruptly, may therefore show "No
versions yet". Bookmark a point whenever you want one for certain.

## Restore a version

1. Press a version in **History**. The document shows that version read-only, in place of the
   editor, while the live document stays as it was.
2. Press **Restore** (the circular-arrow button at the right of the bar; on a phone it shows the
   icon alone). **Stop viewing** at the left puts the live document back instead.

Restoring is safe to undo: the state you had just before restoring is kept as a version of its
own, and the History panel says so ("Restored. The state before restoring is kept as a version.").
Your pan and zoom on a canvas stay where they were.
