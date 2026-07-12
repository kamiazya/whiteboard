import { describe, expect, it } from 'vitest'
import { extractCriticalPathFiles } from './smoke-bundle-size.mjs'

describe('extractCriticalPathFiles', () => {
  it('finds the entry script and modulepreload chunks with lowercase tags/attrs', () => {
    const html = [
      '<script type="module" crossorigin src="/assets/index-abc123.js"></script>',
      '<link rel="modulepreload" crossorigin href="/assets/vendor-react-def456.js">',
    ].join('\n')

    expect(extractCriticalPathFiles(html)).toEqual([
      '/assets/index-abc123.js',
      '/assets/vendor-react-def456.js',
    ])
  })

  it('finds the same files when tag names, attribute names, and rel value are upper/mixed case', () => {
    const html = [
      '<SCRIPT TYPE="module" CROSSORIGIN SRC="/assets/index-abc123.js"></SCRIPT>',
      '<LINK REL="MODULEPRELOAD" CROSSORIGIN HREF="/assets/vendor-react-def456.js">',
    ].join('\n')

    expect(extractCriticalPathFiles(html)).toEqual([
      '/assets/index-abc123.js',
      '/assets/vendor-react-def456.js',
    ])
  })
})
