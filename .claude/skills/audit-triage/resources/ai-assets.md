# AI assets

The `.claude/` asset ecosystem (rules, skills, workflows, agents) is itself
part of the codebase and can drift like any other code — a renamed workflow
arg, a skill referencing a dropped script, two skills quietly duplicating
the same guidance. This dimension audits that ecosystem, not the app.

Scope: `.claude/skills/*/SKILL.md`, `.claude/skills/*/resources/*.md`,
`.claude/workflows/*.workflow.mjs`, `.claude/agents/*.md`, `.claude/rules/*.md`,
and `AGENTS.md`. Resource files are in scope because dimensions like
`audit-triage` and `review-gate` treat their `resources/*.md` as the
authoritative criteria pack (see `## Externalized criteria` in
`audit-triage/SKILL.md`) — drift there is drift in the audit itself, not
merely in a supporting doc.

## Criteria

### 1. Stale cross-references

Check:
- Does a skill or rule reference a workflow arg, script path, agent name, or
  file path that no longer exists or was renamed?
- Does `AGENTS.md` or a rule describe a command/flag that behaves
  differently now, or point at a file that moved?
- Does a skill claim a fact about repo state (e.g. what is or isn't
  gitignored) that contradicts `git ls-files` / `.gitignore` reality?
- Does a `resources/*.md` criteria pack reference a workflow arg, dimension
  name, skill, or embedded-agent section that was renamed or removed, or
  does it drift out of sync with the `SKILL.md` that externalizes it to?

### 2. Frontmatter validity

Check:
- Does every `SKILL.md` have `name:`/`description:` frontmatter, and does
  `name:` match the parent directory name?
- Does every agent `.md` under `.claude/agents/` have a non-empty
  `description:` that explains when to use it?
- Are there frontmatter fields Claude Code silently ignores (unsupported
  keys, wrong value types)?

### 3. Skill/agent overlap or duplication

Check:
- Do two skills cover the same workflow or concern such that one could
  absorb the other without loss of signal?
- Does an agent's body restate guidance that a path-scoped rule already
  auto-loads for the files that agent reads?
- Where duplication between a skill and an embedded agent default is
  deliberate (e.g. `audit-triage`/`review-gate`'s externalized-criteria
  fallback pattern), is it documented as intentional rather than looking
  like an oversight?

### 4. Naming consistency

Check:
- Skills (`skills/*/SKILL.md`): directory name is kebab-case and matches
  the `name:` frontmatter.
- Agents (`.claude/agents/*.md`): kebab-case role-noun filenames.
- Workflows (`.claude/workflows/*.workflow.mjs`): does the internal `meta.name`
  match the filename stem?
- Do references to a skill/agent/workflow elsewhere in `.claude/` use the
  exact current name, not an old one?

### 5. Coverage gaps

Check:
- Does every `.claude/workflows/*.workflow.mjs` have a corresponding
  `.claude/skills/*/SKILL.md` documenting its args/return contract (the gap
  this dimension itself was added to close for `review.workflow.mjs`)?
- Is every workflow listed in `.claude/rules/dev-flow.md`'s workflow index,
  and every skill listed in its `## Skills (load for detail)` index?
- Are there `.claude/agents/*.md` with no skill or rule referencing them
  (orphaned after a refactor)? Advisory, not blocking.

### 6. Docs-vs-rule boundary

Check:
- Does `.claude/rules/*.md` contain only enforcement-relevant, auto-loaded
  content, or has it accumulated background prose that belongs in a skill
  (loaded on demand) instead?
- Does a rule duplicate a skill's detailed how-to instead of pointing to it?
