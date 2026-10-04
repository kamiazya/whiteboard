import { describeMeasureTextConformance } from '@kamiazya/whiteboard-canvas-render/test-utils'
import { opentypeMeasureText } from './test-utils/opentype-measure.js'

describeMeasureTextConformance(() => opentypeMeasureText())
