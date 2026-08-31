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

## Pick an observation that could REFUTE the claim

The rule the others are instances of. Three wrong conclusions in one session
shared this shape: the observation taken was CONSISTENT with the claim and
could not have contradicted it, so it read as confirmation while testing
nothing.

- A mutant reported `failed 1 test` and was read as killed. The failing test
  was a flake, in a file the mutated line cannot reach; three full runs of the
  mutated build all passed. One failure is equally consistent with killed and
  with a flake — only WHICH test failed tells them apart.
- A survivor at `elements[0]?.attrs?.[name]` was hand-checked by mutating both
  optional chains. It went red, and the reported mutant was only one of them.
  Mutating more than what was reported can only produce red; red then says
  nothing about the reported mutant.
- `okSecond` was called unreachable after measuring that `zeroBendFacingFirst`
  never returns two pairs. True, and about a different question: the two pushes
  are mutually exclusive, so a single pair can arrive from either. Measured on
  the branch that actually answers the claim, 242 of 7893 firings came from the
  non-dominant one.

So before running the observation, name the outcome that would make you say the
claim is WRONG. If no outcome of this observation would, you are about to
confirm rather than test — take the discriminator instead: the failing test's
NAME rather than the count, the reported mutant's exact line and columns rather
than the expression around it, the branch the claim is about rather than the one
beside it.

This is also why a diagnosis is cheapest to check while it is still a sentence.
Each of the three cost one extra command to settle, and each was published
first.

## A grep for a phrase is not a test for a claim

Searching a document for the words you would have used answers whether it uses your wording, not
whether it makes your claim — and a miss reads as proof of absence, which is the direction that
does damage: it licenses writing the content again, or deleting the copy that had it.

Four times in one session, while checking whether a skill already held something before cutting
the duplicate:

- `grep 'identical assertion'` reported the two-identical-assertions case absent from this file.
  It is the **Read the stack line** section below, worded "a different assertion in the same test
  comparing to the same literal".
- `grep 'setSystemTime'` reported clock-pinning absent from `docs-sync`, which says "pin the
  clock".
- `grep '--ring'` reported the compose-figure invocation absent from `visual-evidence`, which
  prints the whole command including that flag. This one was not a wording miss at all: `grep`
  parsed `--ring` as an option and exited with an error, and the checking script branched on exit
  status alone, so `grep: unrecognized option` and "no match" arrived as the same answer. Ending
  option parsing (`grep -- '--ring'`) finds it. **A non-zero exit means "did not match" OR "did
  not run"; a script that reads only the status cannot tell you which.**
- `grep 'gh image'` reported the upload step absent from the same file, four lines further down.

So a NEGATIVE from a text search is a hypothesis, not a finding. Confirm it by reading the section
that would hold the claim, or by searching for the thing the claim is ABOUT — the identifier, the
path, the number — rather than the sentence you expect around it. Let the search PRINT rather than
branching on its status, so a tool error cannot arrive dressed as a result. A positive is safe;
only the absence needs the second look.

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
