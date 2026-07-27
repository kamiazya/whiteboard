// Resolve annotate target coordinates into absolute canvas coordinates. Callers
// can force absolute/relative/parent behavior; when omitted, legacy autodetect
// stays in place for backward compatibility.

export type CoordsMode = 'absolute' | 'relative' | 'parent'

export interface ElementRef {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  isDeleted?: boolean
}

export interface ResolveArgs {
  coords?: CoordsMode
  imageId?: string
  target: { x: number; y: number }
}

export interface ResolvedPosition {
  x: number
  y: number
  // Only set for coords:'parent'.
  parentId?: string
  relX?: number
  relY?: number
}

function findImage(elements: ElementRef[], imageId: string | undefined): ElementRef | undefined {
  if (imageId) {
    return elements.find((el) => el.id === imageId && !el.isDeleted)
  }
  return elements.find((el) => el.type === 'image' && !el.isDeleted)
}

export function resolveAnnotationPosition(
  args: ResolveArgs,
  elements: ElementRef[],
): ResolvedPosition {
  const { coords, imageId, target } = args

  // Explicit absolute mode: ignore images and use target as raw pixels.
  if (coords === 'absolute') {
    return { x: target.x, y: target.y }
  }

  // Explicit relative mode: require a reference image and fail fast otherwise.
  if (coords === 'relative') {
    const image = findImage(elements, imageId)
    if (!image) {
      if (imageId) {
        throw new Error(
          `Cannot resolve relative position: imageId "${imageId}" not found or deleted.`,
        )
      }
      throw new Error(
        'Cannot resolve relative position: no image element on this canvas. Pass coords:"absolute" or load_image first.',
      )
    }
    return {
      x: image.x + target.x * image.width,
      y: image.y + target.y * image.height,
    }
  }

  // Parent-follow mode: also return parentId/relX/relY so the annotation can
  // keep following the parent even after it moves.
  if (coords === 'parent') {
    const image = findImage(elements, imageId)
    if (!image) {
      if (imageId) {
        throw new Error(
          `Cannot resolve parent position: imageId "${imageId}" not found or deleted.`,
        )
      }
      throw new Error(
        'Cannot resolve parent position: no image element on this canvas. Pass coords:"absolute" or load_image first.',
      )
    }
    return {
      x: image.x + target.x * image.width,
      y: image.y + target.y * image.height,
      parentId: image.id,
      relX: target.x,
      relY: target.y,
    }
  }

  // Autodetect mode preserves the legacy behavior.
  const image = findImage(elements, imageId)
  if (image) {
    return {
      x: image.x + target.x * image.width,
      y: image.y + target.y * image.height,
    }
  }
  return { x: target.x, y: target.y }
}
