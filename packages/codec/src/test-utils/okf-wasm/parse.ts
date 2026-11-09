import { rustOkf } from './core.js'

// What `../../okf/parse.js` exports, with `parseOkf` answered by the Rust core.
export { hasOkfFrontmatter } from '../../okf/parse.js'
export const parseOkf = rustOkf.parseOkf
