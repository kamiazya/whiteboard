# Pipelines And Roadmaps

In pipeline / roadmap diagrams, do not mix **phase progression and system structure**.

## Good Fits

- CI/CD
- ETL
- migration phases
- rollout stages
- milestone planning

## Shell

- For a pipeline, line up stages in one line
- For a roadmap, treat phases as columns and workstreams as rows
- Choose one main progression path
- Keep gates, milestones, and readiness criteria close to their stage

## Reading Direction

- Pipelines go left-to-right
- Roadmaps progress left-to-right by phase
- Put stage notes below or to the right

## Semantic Grouping

- stage: unit of progression
- gate: pass condition
- milestone: arrival point
- workstream: parallel work
- footer / legend: readiness, KPI, owner

## Hard Rules

- Do not pull too much architecture detail back into the mainline
- Do not overuse backward arrows
- Keep stage names in the same part of speech
- Represent rollback / retry / exception consistently
- Do not cram the rollout plan and the target architecture into one frame

## Common Failures

- Phases and components share the same box grammar
- Stage exit criteria turn into long paragraphs inside boxes
- The roadmap collapses into a bullet list
- Exception arrows outshine the mainline

## Local Surgery

- If there are too many stages: merge them and keep the milestones
- If architecture details leak in: move the target architecture to another frame
- If readiness conditions are too heavy: move them into a footer or side note
- If retry / rollback is scattered: create a separate exception band

## If Stuck

- If you need role-based lanes, see [`./workflows-and-swimlanes.md`](./workflows-and-swimlanes.md)
- If it is really a message flow, see [`./sequence-and-decisions.md`](./sequence-and-decisions.md)
