import { describe, expect, it } from 'vitest'
import { codeText, proseText } from './markdown-code.js'

describe('markdown-code partitions fences the way CommonMark closes them', () => {
  it('keeps a fence open past a marker line that carries an info string', () => {
    const doc = ['~~~sh', 'pnpm first', '~~~example', 'pnpm second', '~~~', 'prose after'].join(
      '\n',
    )
    expect(codeText(doc)).toContain('pnpm second')
    expect(proseText(doc)).not.toContain('pnpm second')
    expect(proseText(doc)).toContain('prose after')
  })

  it('closes a fence on its bare marker, even with trailing spaces', () => {
    const doc = ['```', 'pnpm inside', '```  ', 'pnpm outside'].join('\n')
    expect(codeText(doc)).toContain('pnpm inside')
    expect(proseText(doc)).toContain('pnpm outside')
  })
})
