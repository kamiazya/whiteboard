import { embedderContract } from '../test-utils/embedder-contract.js'
import { createFakeEmbedder } from '../test-utils/fake-embedder.js'

embedderContract('the fake embedder', createFakeEmbedder)
