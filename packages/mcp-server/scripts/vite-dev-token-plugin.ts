import type { Plugin } from 'vite'

// Dev-only Vite plugin that injects window.__WHITEBOARD_DAEMON_TOKEN__
// into every HTML response so TokenStore (via apiFetch) sends
// Authorization: Bearer <token> on every /api/* request.
//
// apply: 'serve' ensures Vite never includes this script in production builds.
//
// WHITEBOARD_TOKEN must be set consistently for both this plugin (browser side)
// and the daemon startup (server side). The mcp:http:dev script accepts
// --token=<value>; ensure-http-dev-daemon.mjs reads the same env var so that
// `export WHITEBOARD_TOKEN=<value> && pnpm dev` keeps the two in sync.
// Without a consistent value the browser sends a token the daemon rejects (401).

export function runtimeConfigDevPlugin(): Plugin {
  return {
    name: 'whiteboard-runtime-config',
    apply: 'serve',
    transformIndexHtml(html: string): string {
      const token = process.env.WHITEBOARD_TOKEN ?? 'whiteboard-dev'
      // Escape `<` so a token containing `</script>` cannot break out of the
      // script tag and inject arbitrary markup. The production server path
      // applies the same guard before inlining runtime config.
      //
      // The token ships on its own global (window.__WHITEBOARD_DAEMON_TOKEN__),
      // not inside __WHITEBOARD_RUNTIME_CONFIG__ — see shared/token-store.ts.
      const tokenJson = JSON.stringify(token).replace(/</g, '\\u003c')
      const script = `<script>window.__WHITEBOARD_DAEMON_TOKEN__ = ${tokenJson};</script>`
      if (!html.includes('</head>')) {
        throw new Error(
          'vite-dev-token-plugin: missing </head> in index.html — runtime config script cannot be injected',
        )
      }
      return html.replace('</head>', `${script}</head>`)
    },
  }
}
