---
name: "py-fp"
description: "Python FP principles with anti-over-engineering focus - Simple > Complex | Evidence > Assumptions"
---

# Python Functional Programming

FP in spirit, Pythonic in expression. Python is not Haskell — don't fight the language.

## CRITICAL: Anti-Over-Engineering

**Never create custom FP utilities** (`pipe`, `compose`, `curry`, custom monads). Use native patterns or established libraries (`toolz`, `itertools`, `functools`).

```python
# DON'T: pipe() utility
def pipe(value, *functions):
    for fn in functions:
        value = fn(value)
    return value

# DO: native early returns
def validate_user(user_data: dict) -> dict:
    required = validate_required(["email", "name"], user_data)
    if not required["valid"]:
        return required
    email = validate_email(user_data)
    if not email["valid"]:
        return email
    return validate_name_length(user_data)

# DON'T: compose() or curry() utilities
# DO: direct calls or functools.partial
from functools import partial
validate_min_length = partial(validate_length, min_len=3)

# DON'T: Custom monads (Maybe, Either, IO)
# DO: result dicts
def get_user(user_id: int, db) -> dict:
    try:
        return {"success": True, "data": db.find(user_id)}
    except Exception as e:
        return {"success": False, "error": str(e)}
```

Match complexity to context: CLI script ≠ production service ≠ data pipeline.

## Core Patterns

### 1. Purity and Side Effect Isolation

Separate business logic from side effects.

```python
# Pure: business logic
def calculate_total(items: list[dict]) -> float:
    return sum(item["price"] for item in items)

# Side effects separate
def log_and_calculate(items: list[dict], logger) -> float:
    total = calculate_total(items)
    logger.info(f"Total: {total}")
    return total
```

Pure functions: 100% testable, `@lru_cache`-able, safe for `multiprocessing`.

### 2. Composition Over Inheritance

```python
def validate_required(value) -> bool:
    return value is not None and value != ""

def validate_email(value: str) -> bool:
    return "@" in value and "." in value.split("@")[-1]

def validate_length(min_len: int, max_len: int):
    return lambda value: min_len <= len(value) <= max_len

def validate_user_email(email: str) -> dict:
    if not validate_required(email):
        return {"valid": False, "error": "Required"}
    if not validate_email(email):
        return {"valid": False, "error": "Invalid email"}
    if not validate_length(5, 100)(email):
        return {"valid": False, "error": "Length"}
    return {"valid": True}
```

### 3. Dependency Injection via Parameters

```python
# Hidden deps — untestable
def save_user(user_data: dict) -> dict:
    hashed = bcrypt.hash(user_data["password"])
    return database.save({**user_data, "password": hashed})

# Explicit deps — fully testable
def save_user(user_data: dict, hasher, database) -> dict:
    hashed = hasher.hash(user_data["password"])
    return database.save({**user_data, "password": hashed})

# Closure-based DI for repeated use
def create_user_service(hasher, database):
    def save(user_data: dict) -> dict:
        return save_user(user_data, hasher, database)
    def find(user_id: int) -> dict:
        return database.find_by_id(user_id)
    return {"save": save, "find": find}
```

### 4. Immutability

```python
from dataclasses import dataclass, replace, field
from typing import NamedTuple

@dataclass(frozen=True)
class User:
    name: str
    email: str
    settings: dict = field(default_factory=dict)

def update_email(user: User, new_email: str) -> User:
    return replace(user, email=new_email)  # new instance

# Dict/list — spread, don't mutate
def update_settings(user: dict, settings: dict) -> dict:
    return {**user, "settings": {**user.get("settings", {}), **settings}}

def update_item(items: list[dict], item_id: int, updates: dict) -> list[dict]:
    return [{**i, **updates} if i["id"] == item_id else i for i in items]
```

> `frozen=True` is shallow — nested dicts/lists remain mutable. Use `pyrsistent` or `MappingProxyType` for deep immutability.

## Python-Specific Patterns

### Comprehensions (Prefer Over map/filter)

```python
# Pythonic FP
active_names = [u["name"] for u in users if u["active"]]
name_by_id = {u["id"]: u["name"] for u in users}
totals = sum(item["price"] for item in items if item["taxable"])
```

### Generators for Lazy Pipelines

```python
def read_records(path: str):
    with open(path) as f:
        for line in f:
            yield parse_record(line)

def filter_valid(records):
    for record in records:
        if record["status"] == "active":
            yield record

def transform(records):
    for record in records:
        yield {**record, "name": record["name"].upper()}

# Compose lazily — no intermediate lists
pipeline = transform(filter_valid(read_records("data.csv")))
```

### itertools / functools

```python
from functools import partial, lru_cache, reduce
from itertools import groupby
from operator import itemgetter, mul

# partial — Pythonic curry
multiply_by_tax = partial(lambda rate, price: price * (1 + rate), 0.08)

# lru_cache — memoize pure functions only
@lru_cache(maxsize=256)
def fibonacci(n: int) -> int:
    return n if n < 2 else fibonacci(n - 1) + fibonacci(n - 2)

# operator — eliminate trivial lambdas
sorted_by_name = sorted(users, key=itemgetter("name"))

def group_by_category(items: list[dict]) -> dict:
    sorted_items = sorted(items, key=itemgetter("category"))
    return {k: list(v) for k, v in groupby(sorted_items, key=itemgetter("category"))}
```

### Pattern Matching (3.10+)

```python
def process_event(event: dict) -> dict:
    match event:
        case {"type": "click", "target": target}:
            return handle_click(target)
        case {"type": "submit", "data": data}:
            return handle_submit(data)
        case {"type": "error", "code": code, "message": msg}:
            return handle_error(code, msg)
        case _:
            return {"error": f"Unknown event type: {event.get('type')}"}
```

### Type Hints

```python
from typing import TypeVar, Callable, Optional
from collections.abc import Iterable

T = TypeVar("T")
U = TypeVar("U")

def transform_all(items: Iterable[T], fn: Callable[[T], U]) -> list[U]:
    return [fn(item) for item in items]

def find_user(users: list[dict], user_id: int) -> Optional[dict]:
    return next((u for u in users if u["id"] == user_id), None)
```

## Data Science / ML

### pandas pipe()

```python
import pandas as pd

def clean_nulls(df: pd.DataFrame) -> pd.DataFrame:
    return df.dropna(subset=["email", "name"])

def normalize_names(df: pd.DataFrame) -> pd.DataFrame:
    return df.assign(name=df["name"].str.strip().str.title())

def add_age_group(df: pd.DataFrame) -> pd.DataFrame:
    bins = [0, 18, 35, 55, 120]
    labels = ["youth", "young_adult", "adult", "senior"]
    return df.assign(age_group=pd.cut(df["age"], bins=bins, labels=labels))

result = raw_df.pipe(clean_nulls).pipe(normalize_names).pipe(add_age_group)
```

### Polars (FP-native)

```python
import polars as pl

result = (
    pl.scan_csv("data.csv")
    .filter(pl.col("status") == "active")
    .with_columns(
        full_name=pl.col("first_name") + " " + pl.col("last_name"),
        age_group=pl.when(pl.col("age") < 30).then(pl.lit("young")).otherwise(pl.lit("senior")),
    )
    .group_by("department")
    .agg(pl.col("salary").mean().alias("avg_salary"))
    .collect()
)
```

## Result Type Pattern

```python
def success(data=None) -> dict:
    return {"success": True, "data": data}

def failure(error: str) -> dict:
    return {"success": False, "error": error}

def process_order(order: dict) -> dict:
    validated = validate_order(order)
    if not validated["success"]:
        return validated
    priced = calculate_pricing(validated["data"])
    if not priced["success"]:
        return priced
    return submit_order(priced["data"])
```

## Testing

```python
import pytest

@pytest.mark.parametrize("price,rate,expected", [
    (100.0, 0.1, 10.0),
    (50.0, 0.2, 10.0),
    (0.0, 0.1, 0.0),
])
def test_calculate_discount(price, rate, expected):
    assert calculate_discount(price, rate) == expected

def test_update_email_returns_new_instance():
    user = User(name="Alice", email="old@test.com")
    updated = update_email(user, "new@test.com")
    assert updated.email == "new@test.com"
    assert user.email == "old@test.com"  # original unchanged
```

## Performance (Evidence-Based Only)

```python
# Memoize pure functions with hashable args
@lru_cache(maxsize=128)
def parse_template(template: str) -> dict:
    return heavy_parse(template)

# Batch generator for large data
def process_large_file(path: str):
    pipeline = transform(filter_valid(read_records(path)))
    batch = []
    for record in pipeline:
        batch.append(record)
        if len(batch) >= 1000:
            yield batch
            batch = []
    if batch:
        yield batch

# Pure functions parallelize trivially
from multiprocessing import Pool
with Pool(4) as pool:
    results = pool.map(process_item, items)
```

## Gotchas

**Recursion limit** — no tail call optimization. Use `reduce` for large inputs:
```python
from functools import reduce
from operator import mul
def factorial(n: int) -> int:
    return reduce(mul, range(1, n + 1), 1)
```

**Mutable defaults** — never use mutable default args:
```python
def add_item(item, items=None):
    return [*(items or []), item]
```

**Shallow freeze** — `frozen=True` doesn't freeze nested dicts. Use `MappingProxyType` or `pyrsistent` for deep immutability.

## Quality Gates

1. Can this be pure? — separate logic from side effects
2. Can this use native patterns? — comprehensions, generators, functools, itertools
3. Is this complexity justified? — evidence-based decisions only
4. Are type hints used? — all public function signatures

## References

| Resource | Load when |
|----------|-----------|
| `references/core-principles.md` | Learning mode, architecture decisions, anti-pattern recognition |
| `references/testing-patterns.md` | Building test suites, Hypothesis property-based testing |
| `examples/` | Complete working code, integration examples |
