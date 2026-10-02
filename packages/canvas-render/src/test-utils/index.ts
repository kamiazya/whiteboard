// The surface other packages' tests import (`./test-utils` in the manifest).
// Deliberately only the measurers: the rest of this folder is canvas-render's
// own corpora and goldens, and exporting them would make every one a contract.
export { createFakeMeasure, createFixedMeasure, type FixedMeasureSpec } from './fake-measure.js'
