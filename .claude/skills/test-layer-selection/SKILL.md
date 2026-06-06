---
name: test-layer-selection
description: How to pick the nearest test layer in the whiteboard repo (mcp-node / mcp-jsdom / mcp-browser / web-browser / E2E) and the commands to run each. Use when writing the red test for a change, or deciding where a regression belongs.
---

# Test Layer Selection

Start with the smallest failing test at the **nearest** layer. Do not jump to broad E2E if a smaller failing test can isolate the bug.

| Layer | Use for | Command |
|---|---|---|
| `mcp-node` | pure functions, stores, routes, server behavior, persistence logic | `pnpm test --project mcp-node` |
| `mcp-jsdom` | React components/hooks when browser layout & pointer behavior are NOT the core risk | `pnpm test --project mcp-jsdom` |
| `mcp-browser` | popovers, dialogs, scroll, focus, keyboard, pointer, restore flows (real browser) in `packages/mcp-server` | `pnpm test --project mcp-browser` |
| `web-browser` | `apps/web` tests needing real browser APIs jsdom lacks: IndexedDB, OPFS, `window.showOpenFilePicker`. File suffix `.browser.test.tsx` | part of `pnpm test:browser` |
| E2E | real routes, server composition, websocket timing, persistence order, multi-step page flows | promote only when needed |

Notes:
- `apps/web` unit/jsdom: `pnpm --filter @kamiazya/whiteboard-web test`.
- Browser suites together: `pnpm run test:browser` (mcp-browser + web-browser); `pnpm run test:browser:trace` for trace artifacts on failure (under `<package>/tmp/vitest-traces`).
- After the targeted test passes, run the broader suite covering the touched area, then `pnpm test`.
- Runtime is the source of truth: if behavior disagrees with a test, fix the test or implementation to match real behavior.
- Passing tests alone are not sufficient — manually verify the real behavior (Playwright/Chrome MCP) before locking the scenario into regression coverage.
