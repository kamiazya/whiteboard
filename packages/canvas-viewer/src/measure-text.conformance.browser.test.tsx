import { describeMeasureTextConformance } from '@kamiazya/whiteboard-canvas-render/test-utils'
import { expect } from 'vitest'
import { ensureViewerFontLoaded } from './font-loading.js'
import { createBrowserMeasureText } from './measure-text.js'

describeMeasureTextConformance(async () => {
  // A measurement against a face that never loaded is the system fallback's,
  // and would make every assertion below a statement about the wrong font.
  expect(await ensureViewerFontLoaded()).toBe('loaded')
  return createBrowserMeasureText()
})
