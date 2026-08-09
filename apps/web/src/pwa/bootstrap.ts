import { setupSwRegistration } from './register-sw.js'

// The literal `import('virtual:pwa-register')` specifier only resolves when
// the VitePWA plugin is active (real dev/build), so this wiring stays in its
// own tiny module — kept out of register-sw.ts, which register-sw.test.ts
// imports directly under plain vitest/jsdom (no VitePWA plugin present).
// Only the daemon injects `__WHITEBOARD_RUNTIME_CONFIG__` into the shell it
// serves; the hosted app is plain static HTML, so its presence is what tells
// these two deployments apart.
const runtimeConfig = (window as { __WHITEBOARD_RUNTIME_CONFIG__?: unknown })
  .__WHITEBOARD_RUNTIME_CONFIG__

setupSwRegistration({
  isProd: import.meta.env.PROD,
  hasServiceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
  isDaemonServed: runtimeConfig !== undefined,
  importRegister: () => import('virtual:pwa-register'),
})
