---
name: ima-vision-handoff
description: Route screenshots, mockups, visual diffs, diagrams, scanned documents, and other image evidence to the IMA vision-handoff agent. Use whenever visual interpretation is needed for planning, implementation, testing, or review.
---

# IMA vision handoff

## Role boundary

Parent sessions route visual interpretation through `ima_delegate` to the `vision-handoff` agent. Do this even when the parent session can inspect images: the handoff keeps visual evidence isolated, bounded, and comparable across phases.

When this skill is loaded by an already-running `vision-handoff` agent, do not delegate again. Produce the evidence report directly within that agent's declared evidence-only authority.

## Assignment contract

Provide a complete visual-evidence assignment with:

- phase context and the source identity;
- one to four unique absolute local image paths through `imagePaths` when local image transport is required;
- exact questions about visible text, layout, state, responsive behavior, or differences;
- the parent decision that the evidence will inform; and
- explicit evidence-only constraints.

Use only the smallest set of accessible image sources needed. Keep source paths and bytes out of the child’s reported evidence; use the returned opaque source identities and safe labels instead.

## Evidence boundary

The `vision-handoff` agent reports direct visual facts, legible text, layout and state observations, visual accessibility signals, and uncertainty. It does not choose architecture, product behavior, implementation files, tests, review outcomes, or lifecycle actions.

The parent owns all non-visual decisions. It may use visual evidence together with repository or browser evidence, but must not claim that a screenshot proves keyboard reachability, semantic names, DOM relationships, screen-reader output, or live announcements.

## Missing evidence

If the agent cannot access or analyze a supplied image, request the smallest concrete replacement source. Do not guess from an inaccessible image or ask the user to manually transcribe it before attempting a usable handoff.
