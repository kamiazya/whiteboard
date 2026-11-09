import { rustOkf } from './core.js'

// What `../../okf/serialize.js` exports, with `serializeOkf` answered by the Rust core.
export { OkfNotYamlSafeError } from '../../okf/serialize.js'
export const serializeOkf = rustOkf.serializeOkf
