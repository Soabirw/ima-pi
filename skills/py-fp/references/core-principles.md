# Python FP Core Principles (Deep Dive)

Comprehensive FP philosophy and patterns for Python. Load this when explaining WHY, making architectural decisions, or need detailed pattern guidance.

## The Pythonic FP Philosophy

Python's creator Guido van Rossum has been explicit: Python is not a functional language. It borrows FP concepts selectively. The key insight is working WITH this design, not against it.

**Pythonic FP means**: Use FP concepts (purity, immutability, composition, higher-order functions) but express them in Pythonic syntax. Don't import Haskell wholesale.

### What to Adopt

| Pattern | Python Expression |
|---------|-------------------|
| Pure functions | Regular functions with no side effects |
| Immutable records | `@dataclass(frozen=True)` or `NamedTuple` |
| Composition | Direct function calls, `pipe()` for pandas |
| Higher-order functions | Comprehensions, `functools`, `itertools` |
| Lazy evaluation | Generators and generator expressions |
| Partial application | `functools.partial` |
| Memoization | `@lru_cache` / `@cache` |
| Pattern matching | `match`/`case` (3.10+) |

### What to Avoid

| Pattern | Why Not in Python |
|---------|-------------------|
| Custom pipe/compose | Adds indirection, not Pythonic |
| Custom curry | `partial` covers the need |
| Custom monads | Fight the language, hard to read |
| Point-free style | Python doesn't support it well |
| Deep recursion | No TCO, 1000-call limit |
| Overloading `__or__` for pipes | Clever but confusing |

## Functional Core, Imperative Shell

The single highest-leverage FP technique for Python. Originated from Gary Bernhardt's "Boundaries" talk.

### Architecture

```
┌─────────────────────────────────────┐
│          Imperative Shell           │
│  (I/O, side effects, orchestration) │
│                                     │
│  ┌─────────────────────────────┐    │
│  │      Functional Core        │    │
│  │  (pure business logic)      │    │
│  │  - calculations             │    │
│  │  - validations              │    │
│  │  - transformations          │    │
│  │  - business rules           │    │
│  └─────────────────────────────┘    │
│                                     │
│  Database, APIs, files, logging     │
└─────────────────────────────────────┘
```

### Example

```python
# === PURE CORE ===

def calculate_order_total(items: list[dict], tax_rate: float) -> float:
    subtotal = sum(item["price"] * item["quantity"] for item in items)
    return round(subtotal * (1 + tax_rate), 2)

def validate_order(order: dict) -> dict:
    if not order.get("items"):
        return {"success": False, "error": "Order must have items"}
    if any(item["quantity"] <= 0 for item in order["items"]):
        return {"success": False, "error": "Quantities must be positive"}
    return {"success": True, "data": order}

def apply_discount(total: float, discount_code: str, discount_table: dict) -> float:
    rate = discount_table.get(discount_code, 0.0)
    return round(total * (1 - rate), 2)


# === IMPERATIVE SHELL ===

def process_order(order: dict, db, payment_gateway, logger):
    """Shell: orchestrates I/O around pure core."""
    validated = validate_order(order)
    if not validated["success"]:
        return validated

    # Pure calculations
    tax_rate = db.get_tax_rate(order["region"])
    discount_table = db.get_discount_table()
    total = calculate_order_total(order["items"], tax_rate)
    final = apply_discount(total, order.get("discount_code", ""), discount_table)

    # Side effects
    charge_result = payment_gateway.charge(order["customer_id"], final)
    if not charge_result["success"]:
        return charge_result

    db.save_order({**order, "total": final, "status": "paid"})
    logger.info(f"Order processed: {final}")
    return {"success": True, "data": {"total": final}}
```

**The ratio to aim for**: 80% pure core, 20% impure shell.

## Immutability Deep Dive

### The Immutability Spectrum in Python

From most to least immutable:

1. **Truly immutable**: `int`, `float`, `str`, `bytes`, `tuple`, `frozenset`
2. **Shallow frozen**: `@dataclass(frozen=True)`, `NamedTuple`
3. **Read-only views**: `types.MappingProxyType`
4. **Convention-only**: Regular objects you choose not to mutate
5. **Deeply immutable (library)**: `pyrsistent.PMap`, `pyrsistent.PVector`

### Frozen Dataclasses — The Default Choice

```python
from dataclasses import dataclass, field, replace

@dataclass(frozen=True)
class Order:
    customer_id: int
    items: tuple[dict, ...]  # Use tuple, not list, for deep immutability
    status: str = "pending"
    metadata: dict = field(default_factory=dict)

# Create
order = Order(customer_id=1, items=({"sku": "A", "qty": 2},))

# "Update" — returns new instance
paid_order = replace(order, status="paid")

# Original is untouched
assert order.status == "pending"
assert paid_order.status == "paid"
```

### When to Use pyrsistent

Only when you need efficient structural sharing for large nested data:

```python
from pyrsistent import pmap, pvector, freeze, thaw

# Convert mutable to immutable
config = freeze({"db": {"host": "localhost", "port": 5432}, "debug": True})

# Efficient "updates" via structural sharing
new_config = config.set("debug", False)
# config is unchanged, new_config shares the "db" subtree

# Convert back when needed for I/O
mutable = thaw(new_config)
```

**Don't reach for pyrsistent** for simple cases — `frozen=True` dataclasses with `replace()` cover 90% of needs.

## Result Type Patterns

### The Standard Shape

```python
from typing import TypeVar, Any

T = TypeVar("T")

def success(data: Any = None) -> dict:
    return {"success": True, "data": data}

def failure(error: str) -> dict:
    return {"success": False, "error": error}
```

### Chaining Results

```python
def chain_results(*steps):
    """Apply steps sequentially, short-circuiting on failure."""
    def run(data):
        current = data
        for step in steps:
            result = step(current)
            if not result["success"]:
                return result
            current = result["data"]
        return success(current)
    return run

# Usage
process = chain_results(validate, transform, enrich)
result = process(raw_data)
```

### Typed Results (For Larger Codebases)

```python
from dataclasses import dataclass
from typing import TypeVar, Generic, Union

T = TypeVar("T")

@dataclass(frozen=True)
class Success(Generic[T]):
    data: T

@dataclass(frozen=True)
class Failure:
    error: str

Result = Union[Success[T], Failure]

def divide(a: float, b: float) -> Result[float]:
    if b == 0:
        return Failure("Division by zero")
    return Success(a / b)

# Pattern matching with results (3.10+)
match divide(10, 3):
    case Success(data=value):
        print(f"Result: {value}")
    case Failure(error=msg):
        print(f"Error: {msg}")
```

## Higher-Order Functions Done Right

### Comprehensions Are Your map/filter

```python
# These are equivalent, but comprehensions are Pythonic:
list(map(str.upper, names))        # Haskell-ish
[name.upper() for name in names]   # Pythonic

list(filter(lambda x: x > 0, nums))   # Haskell-ish
[x for x in nums if x > 0]            # Pythonic

# Nested transformations
{
    dept: [e["name"] for e in employees if e["active"]]
    for dept, employees in grouped.items()
}
```

### When map/filter ARE Appropriate

```python
# When you have a named function already — no lambda needed
clean_lines = list(map(str.strip, lines))
valid_emails = list(filter(is_valid_email, emails))

# With operator module — cleaner than lambda
from operator import itemgetter
sorted_users = sorted(users, key=itemgetter("last_name", "first_name"))
```

### functools.reduce — Use Sparingly

```python
from functools import reduce
from operator import mul

# Good: simple accumulation with named operator
factorial = reduce(mul, range(1, n + 1), 1)

# Bad: complex reduce is hard to read
# Use a loop or comprehension instead
result = reduce(
    lambda acc, x: {**acc, x["key"]: x["value"]},  # Unreadable
    items,
    {}
)

# Better: dict comprehension
result = {item["key"]: item["value"] for item in items}
```

## Error Handling Philosophy

### Exceptions vs Result Types

**Use exceptions for**:
- Truly exceptional conditions (out of memory, disk full)
- Programming errors (wrong type, missing key)
- Framework integration (Django, FastAPI expect exceptions)

**Use result types for**:
- Expected failures (validation errors, not found, business rule violations)
- Operations that callers should handle explicitly
- Pipeline/chain processing where failures are data

```python
# Exceptions for programming errors
def process(data: list[dict]) -> list[dict]:
    if not isinstance(data, list):
        raise TypeError(f"Expected list, got {type(data)}")
    return [transform(item) for item in data]

# Result types for business logic
def withdraw(account: dict, amount: float) -> dict:
    if amount <= 0:
        return failure("Amount must be positive")
    if amount > account["balance"]:
        return failure("Insufficient funds")
    return success({**account, "balance": account["balance"] - amount})
```

## Established Libraries Reference

### When to Pull In a Library

| Need | Library | Justification |
|------|---------|---------------|
| Heavy function composition | `toolz` / `cytoolz` | Battle-tested, Cython performance |
| Persistent data structures | `pyrsistent` | Structural sharing for large data |
| Extended iterators | `more-itertools` | Hundreds of useful utilities |
| Typed error handling | `returns` (dry-python) | Only if team commits to it |
| F#-style pipelines | `expression` | Lighter than `returns` |

### toolz Quick Reference

```python
from toolz import pipe, groupby, valmap, merge

# pipe is acceptable FROM toolz — don't build your own
result = pipe(
    data,
    clean,
    validate,
    transform,
)

# Useful dict operations
grouped = groupby("category", items)
totals = valmap(lambda items: sum(i["price"] for i in items), grouped)
merged = merge(defaults, overrides)
```

**Rule**: Using `toolz.pipe` is fine. Building your own `pipe` is not. The distinction is between using established, tested tools and reinventing them.

## Concurrency and Parallelism

### Pure Functions Enable Easy Parallelism

```python
from multiprocessing import Pool
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor

# CPU-bound: multiprocessing (pure functions serialize safely)
def compute_score(item: dict) -> dict:
    return {**item, "score": heavy_computation(item["data"])}

with ProcessPoolExecutor(max_workers=4) as executor:
    results = list(executor.map(compute_score, items))

# I/O-bound: threading (even with GIL, I/O releases it)
def fetch_data(url: str) -> dict:
    response = requests.get(url)
    return {"url": url, "data": response.json()}

with ThreadPoolExecutor(max_workers=10) as executor:
    results = list(executor.map(fetch_data, urls))
```

### async/await — The Shell Layer

```python
import asyncio

# Pure core — same as synchronous
def process_response(data: dict) -> dict:
    return {**data, "processed": True, "score": compute_score(data)}

# Async shell — handles I/O
async def fetch_and_process(session, url: str) -> dict:
    async with session.get(url) as response:
        data = await response.json()
    return process_response(data)  # Pure function, no await needed
```
