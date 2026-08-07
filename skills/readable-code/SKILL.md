---
name: readable-code
description: Universal, language-agnostic readability guidance for implementation and code review. Use when writing, refactoring, reviewing, or simplifying code for human maintainers.
---

# Readable Code

Optimize for the next person reading the code. Prefer the simplest expression of the intent that fits the project’s conventions.

## Principles

### 1. Name by intent

Use descriptive names. Let code explain what it does; comments should explain why, why not, or a non-obvious constraint.

**Before**
```text
x = invoices.filter(open)
```

**After**
```text
unpaidInvoices = invoices.filter(isOpen)
```

### 2. Keep functions focused

Give each function one cohesive responsibility. Delegate function-size guidance and FP depth to [functional-programmer](../functional-programmer/SKILL.md).

**Before**
```text
saveOrder(input) validates, calculates totals, writes data, and sends mail
```

**After**
```text
validateOrder(input) → calculateTotal(order) → save(order) → notify(order)
```

### 3. Prefer flat control flow

Treat shallow nesting as a principle: use guard clauses or early returns when they make the normal path clear. A justified exception is acceptable when extraction would obscure the control flow. Do not mandate an indentation width or numeric nesting-depth limit.

**Before**
```text
if (eligible) {
  if (hasStock) {
    fulfill(order)
  }
}
```

**After**
```text
if (!eligible) return
if (!hasStock) return
fulfill(order)
```

### 4. Name repeated values

Use named constants for meaningful numbers and strings instead of unexplained literals.

**Before**
```text
if (attempts > 3) retry("pending")
```

**After**
```text
if (attempts > MAX_RETRIES) retry(PENDING_STATUS)
```

### 5. Keep parameter lists comprehensible

Pass a cohesive configuration object when a call needs several related values; destructure the values used at the boundary.

**Before**
```text
createReport(start, end, locale, timezone, format)
```

**After**
```text
createReport({ start, end, locale, timezone, format })
```

### 6. Follow local conventions

Match the project’s established formatting and naming rules. Consistency lowers the reader’s translation cost.

**Before**
```text
get_user_profile(UserId)
```

**After**
```text
getUserProfile(userId)
```

### 7. Keep effects at boundaries

Prefer pure transformations for business rules and make I/O explicit at the edge.

**Before**
```text
calculateTotal(items) writes an audit record while summing
```

**After**
```text
calculateTotal(items) returns a total; recordAudit(total) runs at the boundary
```

### 8. Avoid abstraction for its own sake

A small amount of duplication can be clearer than an abstraction with a misleading name or too many branches. Do not over-fragment cohesive code merely to appear modular.

**Before**
```text
runGenericPipeline(stepA, stepB, stepC) for one short workflow
```

**After**
```text
validateInput(input)
storeInput(input)
notifyOwner(input)
```

### 9. Treat line length as a readability signal

Long lines make review and comparison harder. Apply max-line-length awareness, informed by readability evidence such as Buse & Weimer, without imposing a universal number.

**Before**
```text
return buildNotification(recipient, report, preferences, locale, timezone, deliveryWindow)
```

**After**
```text
return buildNotification(
  recipient,
  report,
  preferences,
  locale,
  timezone,
  deliveryWindow,
)
```

## Deference Boundaries

- [functional-programmer](../functional-programmer/SKILL.md) owns the universal numeric function-size heuristic and general FP principles.
- The matching language FP skill owns language-specific functional patterns, constraints, exceptions, and applicable language-specific FP depth.
- [ima-security-guardrails](../ima-security-guardrails/SKILL.md) owns security requirements; do not replace its input, authorization, data, or output constraints with readability advice.
- The relevant language and project skills own language-specific exceptions and conventions.

## FP-Redundancy Review Outcome

The review found that function-size guidance belongs solely to `functional-programmer`. This skill deliberately does not repeat or enforce a numeric function-size rule; it supplies the universal readability context and links to the owning FP guidance instead.
