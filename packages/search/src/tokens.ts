import { searchCore } from './core.js'

// Beside the entry rather than through it: the tokenizers are what a test of how a
// query is cut up asks, and nothing that ships calls them.

/** The query tokenizer: latin runs as lowercased words, CJK runs as adjacent bigrams. */
export const tokenize = (text: string): string[] => searchCore('tokenize').tokenize(text)

/** The index tokenizer: as `tokenize`, with every CJK character on its own as well. */
export const tokenizeForIndex = (text: string): string[] =>
  searchCore('tokenizeForIndex').tokenizeForIndex(text)
