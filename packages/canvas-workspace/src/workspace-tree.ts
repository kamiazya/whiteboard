import { LoroDoc, type LoroTree, type LoroTreeNode, type TreeID } from 'loro-crdt'

const TREE_KEY = 'tree'
const SEGMENT_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9_-]*[a-zA-Z0-9])?$/

export interface WorkspaceNode {
  readonly id: TreeID
  readonly canvasId: string
  readonly segment: string
}

export interface WorkspaceTreeSnapshot {
  readonly nodes: readonly WorkspaceNode[]
}

export class WorkspaceTree {
  readonly #doc: LoroDoc
  readonly #tree: LoroTree<{ canvasId: string; segment: string }>

  constructor(doc: LoroDoc) {
    this.#doc = doc
    this.#tree = doc.getTree(TREE_KEY) as LoroTree<{
      canvasId: string
      segment: string
    }>
  }

  static fromSnapshot(bytes: Uint8Array): WorkspaceTree {
    const doc = LoroDoc.fromSnapshot(bytes)
    return new WorkspaceTree(doc)
  }

  exportSnapshot(): Uint8Array {
    return this.#doc.export({ mode: 'snapshot' })
  }

  exportFrontier(): Uint8Array<ArrayBuffer> {
    const encoded = this.#doc.version().encode()
    return new Uint8Array(encoded)
  }

  createNode(canvasId: string, segment: string, parent?: TreeID, index?: number): TreeID {
    validateSegment(segment)
    this.#assertNoSiblingConflict(parent, segment)
    const node = this.#tree.createNode(parent, index)
    node.data.set('canvasId', canvasId)
    node.data.set('segment', segment)
    this.#doc.commit()
    return node.id
  }

  move(target: TreeID, newParent?: TreeID, index?: number): void {
    const node = this.#getNode(target)
    const segment = node.data.get('segment') as string
    this.#assertNoSiblingConflict(newParent, segment, target)
    this.#tree.move(target, newParent, index)
    this.#doc.commit()
  }

  rename(target: TreeID, newSegment: string): void {
    validateSegment(newSegment)
    const node = this.#getNode(target)
    const parentNode = node.parent()
    const parentId = parentNode?.id
    this.#assertNoSiblingConflict(parentId, newSegment, target)
    node.data.set('segment', newSegment)
    this.#doc.commit()
  }

  delete(target: TreeID): void {
    this.#tree.delete(target)
    this.#doc.commit()
  }

  getNode(id: TreeID): WorkspaceNode | undefined {
    const node = this.#tree.getNodeByID(id)
    if (!node || this.#tree.isNodeDeleted(id)) return undefined
    return toWorkspaceNode(node)
  }

  children(parent?: TreeID): readonly WorkspaceNode[] {
    if (parent === undefined) {
      const all = this.#tree.getNodes()
      return all.filter((n) => n.parent() === undefined).map(toWorkspaceNode)
    }
    const node = this.#tree.getNodeByID(parent)
    if (!node) return []
    const kids = node.children()
    if (!kids) return []
    return kids.map(toWorkspaceNode)
  }

  resolveAlias(id: TreeID): string | undefined {
    const node = this.#tree.getNodeByID(id)
    if (!node || this.#tree.isNodeDeleted(id)) return undefined
    const segments: string[] = []
    let current: LoroTreeNode<{ canvasId: string; segment: string }> | undefined = node
    while (current) {
      segments.unshift(current.data.get('segment') as string)
      current = current.parent()
    }
    return segments.join('/')
  }

  findByAlias(alias: string): WorkspaceNode | undefined {
    const parts = alias.split('/')
    if (parts.length === 0) return undefined

    let candidates = this.#tree.getNodes().filter((n) => n.parent() === undefined)

    let matched: LoroTreeNode<{ canvasId: string; segment: string }> | undefined

    for (const part of parts) {
      matched = candidates.find((n) => (n.data.get('segment') as string) === part)
      if (!matched) return undefined
      candidates = matched.children() ?? []
    }

    return matched ? toWorkspaceNode(matched) : undefined
  }

  snapshot(): WorkspaceTreeSnapshot {
    return {
      nodes: this.#tree.getNodes().map(toWorkspaceNode),
    }
  }

  #getNode(id: TreeID): LoroTreeNode<{ canvasId: string; segment: string }> {
    const node = this.#tree.getNodeByID(id)
    if (!node) throw new Error(`Tree node not found: ${id}`)
    return node
  }

  #assertNoSiblingConflict(
    parentId: TreeID | undefined,
    segment: string,
    excludeId?: TreeID,
  ): void {
    const siblings = this.children(parentId)
    const conflict = siblings.find((s) => s.segment === segment && s.id !== excludeId)
    if (conflict) {
      throw new Error(`Sibling segment conflict: "${segment}" already exists under this parent`)
    }
  }
}

function validateSegment(segment: string): void {
  if (segment === '') throw new Error('Segment must not be empty')
  if (!SEGMENT_PATTERN.test(segment)) {
    throw new Error(
      `Invalid segment "${segment}": must match /^[a-zA-Z0-9]([a-zA-Z0-9_-]*[a-zA-Z0-9])?$/`,
    )
  }
}

function toWorkspaceNode(node: LoroTreeNode<{ canvasId: string; segment: string }>): WorkspaceNode {
  return {
    id: node.id,
    canvasId: node.data.get('canvasId') as string,
    segment: node.data.get('segment') as string,
  }
}
