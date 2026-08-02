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

The page mounts an OpenCanvas spatial editor. A fresh canvas starts empty —
today the browser UI itself selects, moves, resizes, connects, and edits
existing nodes; drawing brand-new nodes from the toolbar is not yet available
in Browser-local mode. Reload the tab after moving a node or editing its text
and the change is still there — that's your canvas persisting to IndexedDB in
your own browser, with no server and no account.

**Where to go next:** want your AI agent (Claude Code, Codex, Gemini) to draw with
you, or durable canvases as files on disk? That's the **Local daemon** — see
[Quick install](../../README.md#quick-install). Curious how whiteboard scales from a
browser tab to a self-hosted team server? See [the runtime modes](../explanation/).

← Back to [documentation home](../)
