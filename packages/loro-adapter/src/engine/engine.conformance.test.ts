import { describeCrdtEngineConformance } from '../test-utils/crdt-engine-conformance.js'
import { createCrdtEngine } from './engine.js'

describeCrdtEngineConformance(() => createCrdtEngine())
