import { describe, expect, it } from 'vitest'
import { scanReferences } from './scan.js'
import { createUniqueNameResolver } from './unique-name-resolver.js'

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

describe('scanReferences', () => {
  it('finds a bare id wikilink with its position', () => {
    const value = `before [[${ID}]] after`
    expect(scanReferences(value)).toEqual([
      { index: 7, full: `[[${ID}]]`, isEmbed: false, target: ID, alias: undefined },
    ])
  })

  it('finds a name link with alias and an embed', () => {
    const value = `see [[Release plan|the plan]] and ![[${ID}]]`
    const refs = scanReferences(value)
    expect(refs).toHaveLength(2)
    expect(refs[0]).toMatchObject({ target: 'Release plan', alias: 'the plan', isEmbed: false })
    expect(refs[1]).toMatchObject({ target: ID, isEmbed: true })
  })

  it('reports nothing for unclosed brackets', () => {
    expect(scanReferences('[[never closed')).toEqual([])
  })
})

describe('createUniqueNameResolver', () => {
  it('resolves a unique name and refuses a duplicated one', () => {
    const resolve = createUniqueNameResolver([
      { id: 'A', name: 'unique' },
      { id: 'B', name: 'dup' },
      { id: 'C', name: 'dup' },
    ])
    expect(resolve('unique')).toBe('A')
    expect(resolve('dup')).toBeNull()
    expect(resolve('absent')).toBeNull()
  })
})
