import type { Plugin } from 'vite'

// Dev-only Vite plugin that injects window.__WHITEBOARD_RUNTIME_CONFIG__
// into every HTML response so apiFetch (api-client.ts) sends
// Authorization: Bearer <token> on every /api/* request.
//
// apply: 'serve' ensures Vite never includes this script in production builds.
// The default token matches DEV_BEARER_TOKEN in ensure-http-dev-daemon.mjs;
// set WHITEBOARD_TOKEN in the shell to override both consistently.

export function runtimeConfigDevPlugin(): Plugin {
  return {
    name: 'whiteboard-runtime-config',
    apply: 'serve',
    transformIndexHtml(html: string): string {
      const token = process.env.WHITEBOARD_TOKEN ?? 'whiteboard-dev'
      const config = JSON.stringify({ daemonToken: token })
      const script = `<script>window.__WHITEBOARD_RUNTIME_CONFIG__ = ${config};</script>`
      return html.replace('</head>', `${script}</head>`)
    },
  }
}
