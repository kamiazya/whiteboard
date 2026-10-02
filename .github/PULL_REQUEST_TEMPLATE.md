## Summary

<!-- What does this PR do and why? 1-3 bullet points. -->

-

## Test plan

<!-- How was this tested? Check all that apply. -->

- [ ] New or updated tests added at the nearest layer (`mcp-node`, `web-jsdom`, `web-browser`, `canvas-viewer-browser`, …)
- [ ] The suites for the area I touched pass locally (`pnpm test --project <name>`, `pnpm test:browser` for browser changes); CI runs the full matrix
- [ ] Manual verification completed (describe below)
- [ ] E2E coverage added or extended where applicable

## Visual evidence

<!-- For user-visible changes attach a before/after screenshot. Skip for invisible backend changes. -->

## Checklist

- [ ] Commit messages follow Conventional Commits (`feat:`, `fix:`, `chore:`, etc.)
- [ ] PR title is a valid Conventional Commit title (it becomes the squash-merge commit message)
- [ ] Docs updated if this changes user-visible behavior or a published contract
- [ ] No `console.*` calls added to `src/server/**`
- [ ] No hand-written TypeScript interfaces duplicate a Zod schema
