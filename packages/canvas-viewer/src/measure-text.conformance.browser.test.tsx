import { describeMeasureTextConformance } from '@kamiazya/whiteboard-canvas-render/test-utils'
import { expect } from 'vitest'
import { ensureViewerFontLoaded } from './font-loading.js'
import { createBrowserMeasureText } from './measure-text.js'

describeMeasureTextConformance(
  async () => {
    // A measurement against a face that never loaded is the system fallback's,
    // and would make every assertion below a statement about the wrong font.
    expect(await ensureViewerFontLoaded()).toBe('loaded')
    return createBrowserMeasureText()
  },
  {
    // Vendoring the three faces adds 1.1 MB (0.67 MB gzipped) that the font
    // gate boot waits on: 400 ms to 1190 ms for the gate at 10 Mbps, and
    // 1.5 MB more inlined into the widget's single file.
    synthesisedEmphasis:
      'canvas-viewer vendors Roboto Regular only, so a bold run measures 1.6% too narrow and an italic one 2.8% too wide against the export',
  },
)
