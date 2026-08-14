# Code City v2 agent instructions

## Project context

Code City v2 is a deliberate reimplementation of Code City 1.x. The goal is a
useful product developed from explicit needs, deliberate decisions, clear
architecture, and measurable evidence.

Code City 1.0.0 is a baseline for comparison, not a specification to reproduce.
Its production code may contain defects, unnecessary features, and accidental
design. Inspect it when useful, but do not copy or port it by default. Reuse a
contract, fixture, test, or implementation only after checking that it fits an
accepted v2 need and meets the expected quality.

## Sources of truth

* Product scope, behavior, and acceptance criteria:
  `docs/modules/requirements/`
* Architecture documentation in arc42 structure:
  `docs/modules/architecture/`
* Architecture decision records:
  `docs/modules/architecture/pages/adr/`
* Comparison method and measurements:
  `docs/modules/comparison/`
* Executable details: source code, schemas, configuration, and tests

Keep each fact in one authoritative place and link to it elsewhere. Do not
create parallel architecture summaries or duplicate requirements in arc42.

## Requirements and scope

Be pragmatic. Not every change needs a requirement identifier or formal
traceability. Changes must still fit the agreed product scope and must not add
features merely because v1 contains them or because they might be useful later.

Make consequential assumptions visible. Ask for clarification when an
assumption would materially change product behavior, scope, cost, security, or
architecture.

## Architecture decisions

Create an ADR for a significant decision that is costly to reverse, constrains
future work, or changes an important system boundary, technology, data contract,
deployment model, or security property. Do not create ADRs for routine local
implementation choices.

New ADRs start as `Proposed`. The user must explicitly accept an ADR before it
is marked `Accepted` and before implementation depends on that decision. Agents
may draft and revise ADRs, but must not accept them on the user's behalf.

Store one ADR per AsciiDoc file under
`docs/modules/architecture/pages/adr/`, add it to the architecture navigation,
and retain superseded decisions as historical records.

## Documentation quality

Treat documentation quality as a product concern.

* Write for a reader who does not already know the implementation.
* Keep documents short, precise, concrete, and easy to navigate.
* State decisions, reasons, consequences, and evidence directly.
* Remove filler, repetition, slogans, and name-dropping.
* Use jargon only when it adds precision, and define unfamiliar terms.
* Prefer a small useful diagram or example over a long abstract explanation.
* Do not present plans, assumptions, or aspirations as implemented facts.
* Update documentation in the same change as the behavior it describes.
* Use AsciiDoc and the existing Antora module structure.

Architecture information belongs in the arc42 module. Product behavior belongs
in the requirements module. Experimental method and results belong in the
comparison module.

## Implementation approach

* Prefer small, complete vertical slices over broad speculative infrastructure.
* Choose the simplest design that satisfies current accepted needs.
* Keep changes focused and preserve unrelated user work.
* Do not establish architectural conventions accidentally through code. Draft
  an ADR first when the choice is significant.
* Do not add dependencies, abstractions, extension points, or compatibility
  layers without a demonstrated need.
* Test observable behavior rather than incidental implementation details.
* Add a regression test when fixing a defect.
* Keep deterministic behavior deterministic; do not hide instability with
  retries or inflated timeouts.

## Verification

Use judgment and run checks proportional to the change and its risk. Do not run
commands merely as a ritual.

* For documentation changes, run `npm run docs:build`.
* During implementation, run the smallest relevant checks while iterating.
* Run `npm run verify` only when it is still the appropriate repository-wide
  gate and the scope or risk justifies it.
* Never claim that a check passed unless it was executed successfully.
* Report checks run and relevant checks not run at the end of the task.

Update these commands when the v2 toolchain replaces the v1 toolchain.

## Git and pull requests

The `v2` branch is the integration branch for the reimplementation.

* Work on a short-lived branch created from an up-to-date `v2` branch.
* Keep commits focused and use clear conventional commit messages.
* Commit completed work, push the branch, and create or update a pull request
  targeting `v2` automatically.
* Never merge a pull request. The user controls every merge into `v2` and any
  future default branch.
* Do not push directly to `v2` or rewrite shared history.
* Do not include unrelated, generated, local, or secret files in a commit.
