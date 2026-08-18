/**
 * @license
 * Copyright 2021 Google LLC
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * BudouX's phrase segmenter, vendored from budoux@0.9.0 (`module/parser.js`)
 * and typed for this package. The algorithm is unchanged — only the
 * transpiler's `void 0` idioms were written out. See ./README.md for why this
 * is a copy rather than a dependency.
 */

export type BudouxModel = Readonly<Record<string, Readonly<Record<string, number>>>>

/** The feature groups the model scores, in the order the original applies them. */
const UNIGRAMS = ['UW1', 'UW2', 'UW3', 'UW4', 'UW5', 'UW6'] as const
const BIGRAMS = ['BW1', 'BW2', 'BW3'] as const
const TRIGRAMS = ['TW1', 'TW2', 'TW3', 'TW4'] as const

export class Parser {
  private readonly model: Map<string, Map<string, number>>
  private readonly baseScore: number

  constructor(model: BudouxModel) {
    this.model = new Map(
      Object.entries(model).map(([group, weights]) => [group, new Map(Object.entries(weights))]),
    )
    this.baseScore =
      -0.5 *
      [...this.model.values()]
        .flatMap((group) => [...group.values()])
        .reduce((total, weight) => total + weight, 0)
  }

  /** The input split at its phrase boundaries; `[]` for an empty input. */
  parse(sentence: string): string[] {
    if (sentence === '') return []
    const chunks: string[] = []
    let start = 0
    for (const boundary of this.parseBoundaries(sentence)) {
      chunks.push(sentence.slice(start, boundary))
      start = boundary
    }
    chunks.push(sentence.slice(start))
    return chunks
  }

  /** Indices at which a phrase boundary falls. */
  parseBoundaries(sentence: string): number[] {
    const boundaries: number[] = []
    for (let i = 1; i < sentence.length; i++) {
      let score = this.baseScore
      // Score values in models may be negative, so an absent feature
      // contributes 0 rather than being skipped.
      UNIGRAMS.forEach((group, offset) => {
        const from = i - 3 + offset
        score += this.model.get(group)?.get(sentence.substring(from, from + 1)) ?? 0
      })
      BIGRAMS.forEach((group, offset) => {
        const from = i - 2 + offset
        score += this.model.get(group)?.get(sentence.substring(from, from + 2)) ?? 0
      })
      TRIGRAMS.forEach((group, offset) => {
        const from = i - 3 + offset
        score += this.model.get(group)?.get(sentence.substring(from, from + 3)) ?? 0
      })
      if (score > 0) boundaries.push(i)
    }
    return boundaries
  }
}
