/**
 * The scene vocabulary and the renderer/plugin contract.
 *
 * Types only, and deliberately: a scene never crosses a process boundary
 * (what leaves the renderer is an SVG string or the digest's JSON), so per
 * this repo's zod-schema-discipline it needs no runtime schema. The package
 * exists for its position rather than its contents — below the renderer and
 * below every plugin, so neither has to import the other to agree on what a
 * scene is.
 */
export type {
  DecorationContext,
  EdgeRoute,
  EdgeRouteAnchors,
  EdgeRouteRequest,
  EdgeRouter,
  EdgeSide,
  NodeDecoration,
  NodeOutline,
  RenderContribution,
  RoutableElement,
  ScenePoint,
  ShapeContribution,
  ShapeTable,
} from './contribution.js'
export type * from './scene-graph.js'
