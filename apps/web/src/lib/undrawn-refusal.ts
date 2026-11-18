import type { LayoutRefusal, Scene } from '@kamiazya/whiteboard-canvas-render'

/**
 * The refusal a scene carries that nothing drew: a realm whose core did not
 * load cannot draw even the refusal's notice, so its scene holds the refusal
 * and no nodes, and a surface has to say why in words of its own. A refusal
 * the core drew as its notice is not one of these: the picture says it.
 */
export function undrawnRefusal(scene: Scene): LayoutRefusal | undefined {
  return scene.refusal !== undefined && scene.nodes.length === 0 ? scene.refusal : undefined
}
