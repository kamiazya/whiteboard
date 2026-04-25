# Technical Role Profiles

One of the key ideas borrowed from `drawio-skill` is to lock down **role -> appearance** before expanding a technical frame.

## Start With Roles

In technical architecture / infra / workflow diagrams, decide roles first:

- gateway
- service
- queue / bus
- database / store
- external
- security / auth
- error / failure sink
- decision
- container / boundary

If you skip this step, the same kind of thing will keep changing appearance throughout the frame.

## Default Mapping

- gateway: entry / adaptation point. It can share the base box family with services, but it needs an accent that marks it as entry-role
- service: the main processing role; use the base rectangle family
- queue / bus: give it a standalone box; do not bury it in arrow labels
- database / store: make storage legible through silhouette or label
- external: use neutral treatment, outside-boundary placement, or lighter / dashed treatment
- security / auth: draw it as a control tied to a crossing or protected asset; avoid a generic `security` box
- error / failure sink: move it to a side path away from the mainline
- decision: use a diamond or an equivalent conditional node
- container / boundary: use it for the outer shell such as frame, lane, zone, or subgroup

## Rules

- Within one frame, keep the same role in the same shape language
- Prioritize role distinction over brand reproduction
- Keep dashed to one meaning per frame
  - external
  - async
  - optional
  Do not make one dashed style serve all three at once
- Do not rely on color alone; roles should also read from labels, position, and grouping
- Even when using provider icons, keep the role legible through labels, legends, and boundaries
- Gateway / service / security / error do not all need separate shapes. The critical distinction is semantic, not ornamental variety

## Good Starting Profiles

### Architecture

- left: client / trigger
- center-left: gateway / auth
- center: services / workers
- right: store / external dependency
- bottom or side: error / audit / async path

### Infrastructure

- edge: client / CDN / LB / gateway
- middle: compute / service / worker
- side path: queue / bus / eventing
- bottom or inner zone: database / cache / storage
- outside boundary: external / third-party

### Workflow

- lane title: actor / role / system
- rectangle step: action
- diamond: decision
- dashed path: async / message
- side sink: exception / failure handling

## Local Surgery

- same role appears in three visual forms: normalize to one
- queue / bus is buried: promote it to a dedicated box
- external looks internal: move it outside the boundary or into neutral treatment
- security is generic: split it into a control name or crossing label
- error path has the same weight as the mainline: move it to a side path and change line weight or color intent
- everything looks like the same box: restore role difference through position, label, and grouping first
