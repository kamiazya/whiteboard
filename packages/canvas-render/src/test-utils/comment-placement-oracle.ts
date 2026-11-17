export type CommentPlacementRecord =
  | {
      readonly kind: 'candidates'
      readonly anchor: string[]
      readonly size: string[]
      readonly answer: string[][]
    }
  | {
      readonly kind: 'place'
      readonly anchor: string[]
      readonly size: string[]
      readonly obstacles: string[][]
      readonly answer: string[]
    }
  | {
      readonly kind: 'leader'
      readonly anchor: string[]
      readonly bubble: string[]
      readonly radius: string
      readonly answer: string[]
    }
  | {
      readonly kind: 'nearest'
      readonly point: string[]
      readonly path: string[][]
      readonly answer: string[]
    }
