---
name: diagnosis-evidence
description: Make a diagnosis prove it measured what it claims — before reporting a cause, a "not a regression", a mutation check, or a passing verification. Use when debugging a failing test, a CI failure, a flake, or verifying a fix by hand.
---

# A diagnosis is only as good as the proof that you measured what you think

`measured-change` is about instrumenting a CHANGE whose effect you cannot see.
This is about the step before: a FAILURE you are explaining, or a fix you are
calling verified. Both fail the same way — a number arrives, it looks like
evidence, and nothing in it says what was actually exercised.

Every rule below cost a wrong public conclusion in one session.

## Read the stack line before explaining the message

`expected '' to be 'Fast switch'` was diagnosed from the string alone, blamed on
a change that had made a reload slower, and reported as such. The stack line said
`278`, which was the assertion BEFORE the unmount — a different assertion in the
same test comparing to the same literal. The change had nothing to do with it.

Two assertions comparing to one string is ordinary. **The message names the
expectation; only the line names the assertion.**

## An argument about the shape of a change is not a measurement of its effect

A guard was defended with: it can only ever REMOVE cancels, so the set after is a
subset of the set before, so nothing new can break. True, and irrelevant — the
harm was a *needed* cancel going missing. The A/B took one command per side:

| | later double-tap |
|---|---|
| without the guard | `create-node` |
| with the guard | `[]` |

If a claim is about behaviour, run both sides. A property of the diff is not a
property of the product.

## A mutation check must print the state it mutated

A "mutation check" reported the guard as not load-bearing. The restore step had
already run; every one of those eleven runs used the UNMUTATED file. The
conclusion was backwards and was published before anyone noticed.

Make the command prove its own premise:

```bash
F=path/to/file.tsx
BAK=$(mktemp)
cp "$F" "$BAK"
trap 'cp "$BAK" "$F"; rm -f "$BAK"' EXIT   # restore even on ^C or a set -e exit

python3 - "$F" <<'EOF'
import sys
p = sys.argv[1]; s = open(p).read()
old = "the exact line"
assert s.count(old) == 1, f"expected 1 occurrence, found {s.count(old)}"
open(p, 'w').write(s.replace(old, "the mutation", 1))   # once, not everywhere
EOF
echo "mutated: $(grep -c 'the exact line' "$F")"        # expect 0

<run the test — expect RED>

trap - EXIT; cp "$BAK" "$F"; rm -f "$BAK"
echo "restored: $(grep -c 'the exact line' "$F")"       # expect 1
```

The `trap` and the count assertion are the parts that matter. Without the trap a
failure between mutate and restore leaves the working tree mutated, and the next
command you run measures something you did not intend. Without the count, a
pattern that appears twice mutates both sites and the red you get may not be the
red you were testing for.

A green baseline is the normal starting point — that is what the fix bought, and
`test-layer-selection` asks for exactly that shape: fixed code green, revert,
confirm red, restore. What makes a run **inconclusive rather than negative** is a
mutated run that *stays* green while you never saw the original failure. Then the
scenario was not being reached at all, and the check could not have detected the
removal either way.

The sweeper case: the flake only appeared under parallel load, so on a quiet
machine both the fixed and the mutated build passed. The mutation only became
informative once the failure had been reproduced first.

## Assert the count, not the absence of failures

Six runs reported `0 failures`. Six runs had executed zero tests: the command
died at startup with `No projects matched the filter "web-browser"` because it
ran from `apps/web`, where that project is not defined. "Nothing failed" was one
grep away from being reported as "could not reproduce".

Read the `Tests N passed` line. A suite that did not run is not a suite that
passed — and `dev-flow.md` documents the quieter variant, where a bogus
`--project` is silently ignored as long as one other filter matches.

## A verification must assert that the trigger fired

A touch fix "verified" locally: the node survived, exactly as designed. It also
survived on the unfixed build, because the event that triggers the bug was never
dispatched in that environment. The check proved nothing and looked identical to
one that proved everything.

State the trigger as an assertion beside the outcome:

```js
expect(events).toContain('lostpointercapture')   // the cause happened
expect(node).not.toBeNull()                      // and the effect did not
```

Whenever a test can pass because the interesting thing never happened, that is
the assertion it is missing.

## Prefer a control to an explanation

"After the pinch, the later double-tap does nothing" means nothing on its own —
maybe that gesture never worked in this harness. The same sequence with the
prelude removed produced `create-node`, and the finding became real in one extra
run. When a measurement is a single number with no comparison, the cheapest next
step is almost always the control, not another theory.
