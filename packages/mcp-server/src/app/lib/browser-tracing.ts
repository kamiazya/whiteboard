// Relocated to src/shared/browser-tracing.ts because daemon-backend.ts's
// api-client dependency needs it to stay browser-safe (no src/app imports
// allowed in src/shared). Re-exported here so existing src/app imports
// (main.tsx) keep working unchanged.

export type { BrowserTracingOptions } from '../../shared/browser-tracing.js'
export {
  buildWsTracePayload,
  enableBrowserTracing,
  injectTraceContextIntoHeaders,
  resetBrowserTracingForTests,
} from '../../shared/browser-tracing.js'
