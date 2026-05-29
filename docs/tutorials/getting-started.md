# Getting started

whiteboard's canvas runs right in your browser. In **Browser-local** mode your
drawings live in your own browser (IndexedDB) — no account, and nothing leaves
your machine while you work.

A one-click hosted version isn't published yet, so today you run the browser app
locally from a checkout:

```bash
git clone https://github.com/kamiazya/whiteboard.git
cd whiteboard/apps/web
pnpm install
pnpm dev          # open http://localhost:5173
```

Draw a few boxes, refresh the tab, and you'll see your canvas persist — that's
Browser-local storage working.

**Where to go next:** want your AI agent (Claude Code, Codex, Gemini) to draw with
you, or durable canvases as files on disk? That's the **Local daemon** — see
[Quick install](../../README.md#quick-install). Curious how whiteboard scales from a
browser tab to a self-hosted team server? See [the runtime modes](../explanation/).

← Back to [documentation home](../)
