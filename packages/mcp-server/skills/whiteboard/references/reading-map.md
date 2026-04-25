# Excalidraw Reading Map

Read only this first.

`style-reference.md` and `visual-vocabulary.md` are the deep references.
Do **not** open them end-to-end every time. Pick the diagram type first, then open only the notes you need.

If the request is really about **how to collaborate on the diagram itself** such as "let's evolve this together," "tighten it frame by frame," or "stress-test it for a fresh viewer," open [`../../whiteboard-coauthoring/SKILL.md`](../../whiteboard-coauthoring/SKILL.md) before choosing any notes.

## Which Note To Open

### 1. Flow / Architecture / Structural Framing

Open:
- [`flow-and-architecture.md`](./flow-and-architecture.md)
- If you need layered-tier techniques, also open [`layered-architectures.md`](./layered-architectures.md)
- If it is closer to a tree or argument breakdown, also open [`decomposition-and-trees.md`](./decomposition-and-trees.md)

Typical requests:
- I want to diagram the system structure
- I want to show component responsibilities and dependencies
- I want to share a data flow

### 2. Infrastructure / Network / Cloud Boundaries

Open:
- [`infrastructure-diagrams.md`](./infrastructure-diagrams.md)
- If you need zones / nested boundaries / physical-vs-logical path techniques, also open [`cloud-and-network-zones.md`](./cloud-and-network-zones.md)
- If trust boundary / authz / audit flow is the main subject, also open [`trust-boundary-and-security.md`](./trust-boundary-and-security.md)
- If you need dark / light switching guidance or dark-canvas-safe presentation, also open [`dark-mode-techniques.md`](./dark-mode-techniques.md)
- If the work is icon-heavy and needs library search / trial insert / metadata, also open [`library-first-workflow.md`](./library-first-workflow.md)
- If you need to research icon indices / scale, also open [`library-research-prompt-template.md`](./library-research-prompt-template.md)

Typical requests:
- AWS / GCP / Kubernetes / VPC / subnet
- I need to show regions / clusters / trust boundaries
- I need a diagram with queues / buses / gateways / databases

### 3. UI Review / Before-After / Comparison

Open:
- [`review-and-comparison.md`](./review-and-comparison.md)
- If you need mirrored axes or split techniques, also open [`comparison-splits.md`](./comparison-splits.md)

Typical requests:
- `current / problem / proposal`
- screenshot annotation
- A/B comparison or before/after

### 4. Sequence / Branching / Procedures

Open:
- [`sequence-and-decisions.md`](./sequence-and-decisions.md)
- If lanes / handoffs are the main subject, also open [`workflows-and-swimlanes.md`](./workflows-and-swimlanes.md)
- If it is phase progression / rollout, also open [`pipelines-and-roadmaps.md`](./pipelines-and-roadmaps.md)

Typical requests:
- interactions between actors
- conditional branching
- procedures or state transitions

### 5. Theme Switching / Dark-Mode-Safe Diagrams

Open:
- [`dark-mode-techniques.md`](./dark-mode-techniques.md)

Typical requests:
- I want the diagram to survive both dark mode and light mode
- I want a dense technical board designed for a dark canvas
- I want to use glow / fill / low-opacity zones without breaking meaning

## When To Open The Deep References

Open the deep references only when one of these is true:

- you need concrete coordinates or layout recipes
- you want to confirm detailed rules for fonts / colors / frames / groups
- you are unsure which diagram type to choose
- you need to fix a layout that broke after export

Recommended order:
1. this `reading-map.md`
2. 1-2 relevant notes
3. one extra family-specific playbook if needed
4. [`../style-reference.md`](../style-reference.md) if needed
5. [`../visual-vocabulary.md`](../visual-vocabulary.md) if needed
