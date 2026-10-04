# Cloudflare Pages Deploy MVP

## What this is

`apps/web` is a zero-install browser app deployed to Cloudflare Pages. In the MVP configuration the **browser** is the keeper: all canvas data is stored in the user's own IndexedDB, with no server or account required.

## Guarantees in place

| Contract | Where enforced |
|---|---|
| Build output goes to `apps/web/dist/` | `wrangler.toml` `pages_build_output_dir` |
| Security headers (CSP, X-Frame-Options, …) are served on every route | `apps/web/public/_headers` → copied into `dist/` at build time |
| CSP has no wildcard sources; `script-src` and `default-src` are `'self'`; `connect-src` admits only `'self'` and the font catalogue's pinned origin (a hosted page reaches a local daemon through the extension, never over loopback) | `headers-policy.test.ts` + `smoke-artifact.mjs` |
| Cloudflare Pages preview deploys (`*.kamiazya-whiteboard.pages.dev`) enter `invalid-config`, not the browser keeper | `App.tsx` passes `window.location.origin` to `resolveHostedProviderStateFromRaw`; preview origins are rejected at bootstrap |
| No Cloudflare API tokens or account IDs in the repo | `web-app-boundary.test.ts` CF secrets drift guard |

## What is NOT decided yet

- **Canonical custom domain** — `https://kamiazya-whiteboard.pages.dev` is provisional. A custom domain has not been chosen or registered.
- **Passkey / WebAuthn** — `kamiazya-whiteboard.pages.dev` is **not** a passkey RP ID. Do not use it as one.
- **OAuth / PKCE** — no authorization server is configured.

## Deploying

Three workflows deploy `apps/web` to the Pages project `kamiazya-whiteboard` (the `name` in `apps/web/wrangler.toml`). Each one skips its deploy step while the Cloudflare secrets are absent, and `web-app-boundary.test.ts` allowlists exactly these workflows to hold them:

| Workflow | Trigger | Deploys | GitHub environment |
|---|---|---|---|
| `release.yml` (`deploy-web` job) | a release created by release-please (the Release PR merged) | production, `https://kamiazya-whiteboard.pages.dev` | `production-web` |
| `deploy-preview.yml` | push to `main`, or manual dispatch | the `latest` branch alias, `https://latest.kamiazya-whiteboard.pages.dev` | `preview-web` |
| `preview-pr-deploy.yml` | completion of `preview-pr-build.yml` for a same-repository pull request | a per-PR branch alias, with its URL commented on the PR | `preview-web` |

The pull-request path is split in two so PR code never runs next to deploy secrets: `preview-pr-build.yml` builds with no secrets, and `preview-pr-deploy.yml` publishes that artifact without running any of it. `preview-cleanup.yml` and `preview-retention.yml` release the GitHub deployment records and prune old Cloudflare preview deployments. The release path and its environments are in [releasing.md](../releasing.md).

A manual deploy needs a Cloudflare account with the `kamiazya-whiteboard` Pages project:

```sh
pnpm check:pages-release              # pnpm build + smoke:artifact + smoke:preview-origin
npx wrangler pages deploy apps/web/dist --project-name kamiazya-whiteboard
```

`check:pages-release` is the single pre-deploy gate. It delegates to the private `@whiteboard/checks` runner, which builds `apps/web/dist/`, verifies artifact integrity (`smoke:artifact`), and confirms preview-origin rejection in a real browser (`smoke:preview-origin`, needs Playwright + a local `127.0.0.1` bind). It is the `pages-release` tier in `release-gate-matrix.json` and is deliberately **not** part of `check:release-candidate`; the CI `verify` job runs the same smoke primitives on every PR, and the workflows above do not run `check:pages-release` itself, so run it before a manual deploy. See [testing.md → Hosted Web App Release Gates](../testing.md#hosted-web-app-cloudflare-pages-release-gates) for the full gate / security-review map.

## Single-page-app fallback

The app has client-side routes (`/w/:workspaceId`, `/local/:documentId`, …) with no file in `dist/`. Pages serves `index.html` for those paths on its own **as long as the project has no top-level `404.html`**; adding one turns that behaviour off and every deep link answers 404. There is no `_redirects` file: a `/* /index.html 200` rule is rejected by wrangler as an infinite loop and ignored, and deep links answer 200 without it. `smoke-artifact.mjs` asserts that `dist/` carries neither file.

## Preview origins

Cloudflare automatically creates preview deploys at `https://<hash>.kamiazya-whiteboard.pages.dev`. These are intentionally blocked: the app returns an `invalid-config` error page on any preview origin. This prevents a misconfigured preview from silently acting as a real whiteboard.

## Local development

```sh
pnpm --filter @kamiazya/whiteboard-web dev            # Vite dev server on http://localhost:5173
pnpm --filter @kamiazya/whiteboard-web preview:pages  # build, then serve dist/ through `wrangler pages dev` to exercise Pages behaviour (headers, SPA fallback)
```

`wrangler.toml` pins `compatibility_date` so `wrangler pages dev` keeps starting as the calendar moves; raise it together with the `wrangler` devDependency.

`localhost` and `127.0.0.1` origins are allowed to enter browser mode for local development.
