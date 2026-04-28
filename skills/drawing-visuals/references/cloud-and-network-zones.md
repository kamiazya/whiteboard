# Cloud And Network Zones

In cloud / network zone diagrams, separate **nested boundaries and path types** before anything else.

## Good Fits

- AWS / GCP / Azure / Kubernetes deployments
- organizing regions / VPCs / subnets / clusters
- public / private split
- showing physical links alongside logical flow
- hub-and-spoke networks

## Shell

- Place the outer boundary first
  - region / account / VPC / cluster / subnet
- Decide on one main path
- Separate physical / bidirectional links from logical / request flows
- Before routing through the center, see whether cross-zone relations can be pushed to the perimeter
- Put the legend and glossary outside the zones

## Reading Direction

- Request / data flow goes left-to-right
- Nested zones should read outer -> inner
- Push failover or replicas below or to the right
- Separate sync and async paths into different bands

## Semantic Grouping

- zone: region / VPC / subnet / namespace / cluster
- edge: ingress / gateway / LB / CDN
- compute: service / pod / function / VM
- data: DB / cache / queue / bus
- external: third-party / on-prem / client

## Hard Rules

- Do not omit zone labels
- Put zone labels in separate text at the top-left, not in the zone rect `text`
- Keep legends / notes outside the zone
- Do not bury queues / buses in arrow labels
- Do not style physical links and logical flows the same way
- Do not overload solid / dashed / dotted with multiple meanings in one frame
- Do not run long diagonal cross-zone arrows through the middle of zones
- Do not recolor provider icons in ways that hurt recognizability

## Common Failures

- Too many zones make components stop being the focal point
- Subnet and namespace levels get mixed together
- External dependencies blend into the internal zone
- The failover path is louder than the main path
- Cross-zone arrows create spaghetti through the middle of zones
- It is unclear whether the diagram is a network view or an app-flow view

## Local Surgery

- If the zone stack is too heavy: remove one layer or split into another frame
- If paths cross: push external / async paths above or below
- If the zone label is buried: stop using rect text and return to free-standing labels
- If cross-zone relations are messy: move zones adjacent to each other or use elbow / perimeter routing
- If DB / queue elements are buried: promote them to dedicated labeled boxes
- If icons are too loud: move more meaning back into the legend, frame, and labels

## If Stuck

- For broad guidance, see [`./infrastructure-diagrams.md`](./infrastructure-diagrams.md)
- If trust crossings are the focal point, see [`./trust-boundary-and-security.md`](./trust-boundary-and-security.md)
