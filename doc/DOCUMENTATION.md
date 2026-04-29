# Documentation

## Purpose

- Documentation exists to reduce ambiguity for the next reader.
- The default reader is either Nick or another LLM working without memory.
- Document intent, contracts, invariants, non-obvious behavior, and notable historical decisions.
- When a change would otherwise look arbitrary later, record what changed, why it changed, and the date.
- Treat history as context recovery, not automatic precedent.
- Do not restate what the code already says clearly.

## Default

- Use TSDoc for exported APIs.
- Optimize for grep, hover text, and future edits.
- Optimize for cross-session continuity. Assume future readers will not remember the discussion that produced the code.
- Prefer trigger words over long prose: intent, invariant, boundary, why, date, side effects, failure mode.
- Link related code or docs when a practical dependency, coupled update, or external constraint would be easy to miss.
- If a comment is long because the code is confusing, fix the code first.
- Documentation is part of the change, not cleanup to maybe do later.

## Document This

- Exported functions.
- Exported constants with user-facing meaning or non-obvious invariants.
- Schemas at boundaries when the name is not enough.
- Internal helpers only when the why or constraint is non-obvious.

## Function Rule

- Start with one sentence from the caller's perspective.
- Add only the details needed to use or safely change the code.
- Prefer tags only when they carry real information: `@param`, `@returns`, `@throws`, `@example`.

## Always Capture

- What this does.
- What assumptions or invariants matter.
- What can fail.
- Any side effects or boundaries.
- For notable decisions: what changed, why, and the date.
- Any practical dependency that cannot be enforced cleanly with types, tests, or linting.

## History Rule

- Record history when it preserves intent that would otherwise be lost across time or sessions.
- Prefer decision history over activity history.
- Good history explains the constraint, tradeoff, or reason a surprising choice exists.
- Do not document a change just because it happened.
- Old rationale is evidence, not law. Re-evaluate it when the surrounding code, requirements, or constraints change.
- If confidence is low, say so directly instead of turning a weak past decision into a strong rule.

## Links

- Use Markdown links in TSDoc and repo docs when pointing at related files, commands, or design notes.
- Prefer relative repo paths for links to files in this repository so docs remain portable across machines and workspace locations.
- Prefer direct file links when a future change must also consider another module, schema, command, or document.
- If a reader would need to update two places together, say so and link both places.
- Links should explain why the target matters, not just that it exists.

## Promote To `doc/`

- If context is larger than a local function or file, consider a dedicated document under `doc/`.
- Before creating a new document, check whether an existing document already covers the topic and should be updated instead.
- Use dedicated docs for architecture, domain rules, operational procedures, and cross-cutting constraints.
- If a change adds a big, meaty piece of functionality, architecture, or operating procedure, decide explicitly whether a dedicated doc is warranted.
- Inline comments should point to the deeper doc when the full reasoning would be noisy in code.
- Prefer one focused document per topic over burying large decisions in scattered comments.

## Main Docs

- The main docs in `doc/` should be linked from [README.md](../README.md) so a new reader can discover them quickly.
- Keep the README doc list ordered by usefulness to a new contributor: overview first, then stack and workflow, then narrower conventions.
- Add a doc to the README when it is broadly useful for understanding or changing the system.
- Core operational surfaces such as the CLI deserve dedicated docs when they are central to how the system is used.
- Do not clutter the README with narrow one-off notes that only matter to a single subsystem or migration.

## Do Not Capture

- Obvious control flow.
- Type information already expressed clearly in TypeScript.
- Temporary implementation narration.
- History without present-day value.

## Bar

- A future reader should be able to answer: what is this, why is it this way, what can fail, and which old decisions still matter today.
- A future reader should be able to find the next file or document they need without rediscovering the dependency from scratch.
- If behavior changes, update the docs in the same change.
