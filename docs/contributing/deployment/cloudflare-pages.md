# Cloudflare Pages Deploy MVP

## What this is

`apps/web` is a zero-install browser app deployed to Cloudflare Pages. In the MVP configuration it runs in **browser-local mode**: all canvas data is stored in the user's own IndexedDB, with no server or account required.

## Guarantees in place

| Contract | Where enforced |
|---|---|
| Build output goes to `apps/web/dist/` | `wrangler.toml` `pages_build_output_dir` |
| Security headers (CSP, X-Frame-Options, …) are served on every route | `apps/web/public/_headers` → copied into `dist/` at build time |
| CSP has no wildcard sources; `script-src` and `default-src` are `'self'` | `headers-policy.test.ts` + `smoke-artifact.mjs` |
| Cloudflare Pages preview deploys (`*.kamiazya-whiteboard.pages.dev`) enter `invalid-config`, not browser-local | `App.tsx` passes `window.location.origin` to `resolveHostedProviderStateFromRaw`; preview origins are rejected at bootstrap |
| No Cloudflare API tokens or account IDs in the repo | `web-app-boundary.test.ts` CF secrets drift guard |

## What is NOT decided yet

- **Canonical custom domain** — `https://kamiazya-whiteboard.pages.dev` is provisional. A custom domain has not been chosen or registered.
- **Passkey / WebAuthn** — `kamiazya-whiteboard.pages.dev` is **not** a passkey RP ID. Do not use it as one.
- **OAuth / PKCE** — no authorization server is configured.
- **Local dev via Wrangler** — `wrangler pages dev` is not part of the current workflow. Use `pnpm dev` (Vite) for local development.

## Deploying

Manual deploy (requires Cloudflare account with the `whiteboard` Pages project):

```sh
pnpm check:pages-release              # pnpm build + smoke:artifact + smoke:preview-origin
npx wrangler pages deploy apps/web/dist --project-name whiteboard
```

`check:pages-release` is the single pre-deploy gate. It delegates to the private `@whiteboard/checks` runner, which builds `apps/web/dist/`, verifies artifact integrity (`smoke:artifact`), and confirms preview-origin rejection in a real browser (`smoke:preview-origin`, needs Playwright + a local `127.0.0.1` bind). It is the `pages-release` tier in `release-gate-matrix.json` and is deliberately **not** part of `check:release-candidate` or the CI `verify` job — run it manually before a human-triggered deploy. Automated CI/CD deploy is not wired up yet. See [testing.md → Hosted Web App Release Gates](../testing.md#hosted-web-app-cloudflare-pages-release-gates) for the full gate / security-review map.

## Preview origins

Cloudflare automatically creates preview deploys at `https://<hash>.kamiazya-whiteboard.pages.dev`. These are intentionally blocked: the app returns an `invalid-config` error page on any preview origin. This prevents a misconfigured preview from silently acting as a real whiteboard.

## Local development

```sh
cd apps/web
pnpm dev    # Vite dev server on http://localhost:5173
```

`localhost` and `127.0.0.1` origins are allowed to enter browser-local mode for local development.
