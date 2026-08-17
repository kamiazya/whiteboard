# Trust Boundary And Security

For security-oriented diagrams, lock down **what is being protected and where boundaries are crossed** first.

## Good Fits

- auth / authz
- trust boundary
- public / private / internal split
- audit / detection / secret handling

## Shell

- Place boundaries before components
- Choose one access flow as the main path
- Move audit / telemetry / async detection to side paths
- Keep legends / glossaries outside the boundary

## Reading Direction

- Access flow should be left-to-right
- Nested boundaries should read outer -> inner
- Audit / async paths should look different from the main flow

## Labels

- Keep boundary labels short in the top-left
- Do not use the boundary rect `text`; place separate text instead
- Prioritize protocol / credential / control names in crossing labels
  - `JWT`
  - `mTLS`
  - `IAM`
  - `audit`

## Hard Rules

- Do not use danger color on every security box
- Do not style access flow and audit flow with the same arrow treatment
- Default to solid = access and dashed = audit / async, and do not overload meanings in one frame
- Do not hide secret / key / token handling behind a generic `security` box
- Tie each security control to the protected asset or the crossing it governs
- If public / private / internal boundaries appear, do not omit their names

## Common Failures

- The trust boundary becomes a mere background rectangle
- The audit path carries the same weight as the access path
- Authentication and authorization are flattened into one box
- The diagram turns into a list of security products without showing what is being protected

## Local Surgery

- If the boundary is weak: rebuild the nested zones
- If there are too many security boxes: narrow each one to a clearer role
- If the access path disappears: demote audit into a side path
- If a generic `security` box remains: replace it with a concrete control name

## If Stuck

- For cloud / subnet context, see [`./infrastructure-diagrams.md`](./infrastructure-diagrams.md)
- For conditional flow, see [`./sequence-and-decisions.md`](./sequence-and-decisions.md)
