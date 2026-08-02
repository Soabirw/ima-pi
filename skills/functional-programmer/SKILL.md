---
name: "functional-programmer"
description: "Functional programming principles and philosophy - pure functions, immutability, composition, side effect isolation, declarative style. Trigger when: discussing FP concepts, transitioning from OOP, explaining why FP matters, architectural mindset shifts. This skill covers principles ONLY - see js-fp, php-fp, etc. for implementation patterns."
---

# FP Principles

FP is a mindset, not an API signature. Not `pipe()`, `compose()`, or `curry()`.

## Seven Pillars

### 1. Pure Functions
Same input → same output, no side effects. Enables testing without mocks, safe parallelization, predictable debugging.

### 2. Immutability
Never mutate data. Create new data instead. Eliminates aliasing bugs, race conditions, stale references.

### 3. Function Composition
Build complex behavior by combining simple functions. Small composable pieces > monolithic functions.

### 4. First-Class Functions
Functions are values — pass, return, store them. Enables higher-order patterns and behavior injection without inheritance.

### 5. Referential Transparency
Expression replaceable with its value without behavior change. Enables safe refactoring, memoization, compiler optimization.

### 6. Side Effect Isolation
Pure core (business logic) + impure shell (I/O). Shell calls core, never vice versa. Target: 80% pure, 20% shell.

Pure core: calculations, transformations, validations, business rules.
Impure shell: database, API calls, user I/O, logging, filesystem.

### 7. Declarative Style
Describe WHAT, not HOW. Express business logic, not mechanics.

## Composition Over Inheritance

Inheritance problems: fragile base class, gorilla-banana (unwanted dependencies), diamond ambiguity, deep hierarchy opacity.

Use "has-a" (composition) not "is-a" (inheritance). Behavior assembled at runtime, loosely coupled.

OOP's valid contributions — encapsulation and polymorphism — achieved through closures and first-class functions.

## Anti-Over-Engineering (PRIMARY)

**Never create custom FP utilities** (`pipe`, `compose`, `curry`, custom monads). Use established libraries or native language patterns.

Every abstraction costs: learning curve, debugging complexity, maintenance burden, mental overhead.
Test: Does this abstraction pay for itself? Would a junior dev understand it?

**File size smell**: >500 lines = likely multiple responsibilities. Split by cohesion, not line count.

**Match complexity to context**: CLI script ≠ production API ≠ weekend project. Simple problem + complex solution = over-engineering.

## Architecture

**Explicit dependencies**: Functions receive everything as parameters. No globals, no hidden state. Signature tells the full story.

**Result types over exceptions**: Return `{ success, data, error }`. Makes error handling explicit, no hidden control flow, testable error paths.

## Core Directives

1. Functions are the unit of abstraction — not classes, not modules
2. Data flows, never changes — transform, don't mutate
3. Side effects are dangerous — isolate and control them
4. Composition beats inheritance — small pieces > large hierarchies
5. Explicit beats implicit — dependencies, data flow, error handling
6. Simple beats clever — boring, readable code wins
7. Evidence beats assumptions — add complexity only when needed
