import { setupSwRegistration } from './register-sw.js'

// The literal `import('virtual:pwa-register')` specifier only resolves when
// the VitePWA plugin is active (real dev/build), so this wiring stays in its
// own tiny module — kept out of register-sw.ts, which register-sw.test.ts
// imports directly under plain vitest/jsdom (no VitePWA plugin present).
setupSwRegistration({
  isProd: import.meta.env.PROD,
  hasServiceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
  importRegister: () => import('virtual:pwa-register'),
})
