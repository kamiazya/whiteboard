import { describe, expect, it } from 'vitest'
import { folderNameRefusal, foldersOf, pathAfterFolderMove, pathInFolder } from './folder-moves.js'

const doc = (path: string) => ({ documentId: path, path })

describe('folder arithmetic', () => {
  it('lists every ancestor folder once, in order', () => {
    expect(foldersOf([doc('a/b/c'), doc('a/d'), doc('top'), doc('z/y')])).toEqual(['a', 'a/b', 'z'])
  })

  it('keeps the last segment when moving into a folder or the root', () => {
    expect(pathInFolder('design/login', 'archive/2024')).toBe('archive/2024/login')
    expect(pathInFolder('design/login', '')).toBe('login')
  })

  it('refuses names that are empty, nested or outside the path grammar', () => {
    expect(folderNameRefusal('  ', '')).not.toBeNull()
    expect(folderNameRefusal('a/b', '')).not.toBeNull()
    expect(folderNameRefusal('plans', 'design')).toBeNull()
  })

  it('maps a path through a folder rename only when it sits under it', () => {
    expect(pathAfterFolderMove('design/ui/x', 'design', 'plans')).toBe('plans/ui/x')
    expect(pathAfterFolderMove('designs/x', 'design', 'plans')).toBe('designs/x')
  })
})
