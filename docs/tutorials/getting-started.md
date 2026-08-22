# Getting started

whiteboard's canvas runs right in your browser. In **Browser-local** mode your
drawings live in your own browser (IndexedDB) — no account, and nothing leaves
your machine while you work.

Today you run the browser app locally from a checkout. **Prerequisites:** Node.js
and pnpm (run `corepack enable` if you don't already have pnpm).

```bash
git clone https://github.com/kamiazya/whiteboard.git
cd whiteboard      # pnpm workspace root — required for catalog: dependency resolution
pnpm install
pnpm --filter @kamiazya/whiteboard-web dev   # open http://localhost:5173
```

On a fresh browser the page asks what you'll make first — pick **Canvas**
(notes you place and connect in space) or **Markdown note** (start writing;
you can put it on a canvas later) and it opens ready to work in.

![Onboarding chooser](../assets/onboarding-chooser.png)

Once you have documents, the page lands on your document browser: a folder
tree with a preview pane. Click a card to preview it, **Open** to edit it,
and use the toolbar to search everything, create markdown notes and
canvases, or move a document to a new path.

![Browser-local document browser](../assets/browser-local-list.png)

A fresh canvas starts empty. Double-click empty canvas space to make a note
and start typing immediately, or open the **+** menu in the bottom dock: tap
an entry to place it in the middle of the view, or drag one onto the canvas
to drop it exactly where you want it. In **Select** mode, right-clicking
(long-pressing on touch) empty space offers the same creations, placed where
you pressed — Hand mode is navigation only, so it deliberately leaves the
right-click menu closed. The
browser UI also selects, moves, resizes, connects, and edits existing nodes,
and deletes the selected node with Delete/Backspace (disabled while you're
typing in its text editor, so Backspace edits text instead of deleting the
note). Reload the tab after any of these edits and the change is still
there — that's your canvas persisting to IndexedDB in your own browser, with
no server and no account.

**Where to go next:** want your AI agent (Claude Code, Codex, Gemini) to draw with
you, or durable canvases as files on disk? That's the **Local daemon** — see
[Quick install](../../README.md#quick-install). Curious how whiteboard scales from a
browser tab to a self-hosted team server? See [the runtime modes](../explanation/).

← Back to [documentation home](../)
