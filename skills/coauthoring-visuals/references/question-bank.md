# Question Bank

Short seed questions to use when generating viewer questions.

## Architecture

- What does each box own, and where does its responsibility stop?
- Which arrows are sync, async, or manual?
- Where do data or events enter, and where do they leave?
- What has been omitted, and is that omission safe for the decision at hand?
- Where are the failure points or bottlenecks?
- Do the boxes for the same role still look like the same kind of thing?
- Is this a context, container, component, or deployment diagram?
- Can the system boundary or focal structure be found within 5 seconds?
- Can the viewer tell the main direction of flow without tracing every line?
- Can relationships be followed one by one, or do crossings break the reading path?

## Review / Comparison

- What is current, and what is proposal?
- Where is the problem, and why is it a problem?
- What is the comparison axis, and can each frame be compared on that same axis?
- Which changes are essential, and which are side effects?
- What decision is the viewer supposed to make after reading this?

## Process / Workflow

- Who owns each step, and where does the handoff occur?
- Can sync and async paths be distinguished?
- Are messages that cross lanes or pools still visible?
- Where are the decision points and exception paths?
- Should this really be explained as a flow, or should it be split into a responsibility diagram?

## Security / Boundaries

- Where is the trust boundary?
- Can the viewer distinguish access flow from audit flow?
- Where are authentication, authorization, secrets, and audit handled?
- Are public / private / internal boundaries visible?
- Are security concerns mixed into the main flow too heavily?

## Infrastructure

- Where are the public / private / trust boundaries?
- Are region, subnet, cluster, and namespace boundaries visible?
- Can the viewer distinguish stateful from stateless components?
- Where are external dependencies, queues, gateways, and secret handling?
- Are availability and redundancy assumptions visible in the diagram?
- Are external / security / async path styles being used with one stable meaning?
