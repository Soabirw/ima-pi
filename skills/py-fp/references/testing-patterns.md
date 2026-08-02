# Python FP Testing Patterns (Deep Dive)

Comprehensive testing strategies for functional Python code using pytest. Load this when building test suites, improving coverage, or need testing guidance.

## The FP Testing Advantage

Pure functions are trivially testable:
- No setup/teardown ceremony
- No mocking infrastructure
- All edge cases enumerable
- Parametrized testing is natural

## pytest Fundamentals for FP

### Parametrized Tests — The Core Pattern

```python
import pytest

@pytest.mark.parametrize("input_val,expected", [
    ("hello@example.com", True),
    ("invalid", False),
    ("", False),
    ("a@b.c", True),
    ("@no-local.com", False),
    ("no-domain@", False),
])
def test_validate_email(input_val, expected):
    assert validate_email(input_val) == expected
```

### Grouped Parametrize for Complex Cases

```python
@pytest.mark.parametrize("items,tax_rate,expected", [
    # Happy path
    ([{"price": 10, "qty": 2}, {"price": 5, "qty": 1}], 0.1, 27.50),
    # Empty order
    ([], 0.1, 0.0),
    # Zero tax
    ([{"price": 100, "qty": 1}], 0.0, 100.0),
    # High precision
    ([{"price": 9.99, "qty": 3}], 0.0825, 32.44),
])
def test_calculate_order_total(items, tax_rate, expected):
    assert calculate_order_total(items, tax_rate) == expected
```

### Testing Result Types

```python
def test_withdraw_success():
    account = {"id": 1, "balance": 100.0}
    result = withdraw(account, 30.0)
    assert result["success"] is True
    assert result["data"]["balance"] == 70.0

def test_withdraw_insufficient_funds():
    account = {"id": 1, "balance": 10.0}
    result = withdraw(account, 50.0)
    assert result["success"] is False
    assert "insufficient" in result["error"].lower()

@pytest.mark.parametrize("amount,should_succeed", [
    (50.0, True),
    (100.0, True),    # Exact balance
    (100.01, False),  # Just over
    (0.0, False),     # Zero
    (-10.0, False),   # Negative
])
def test_withdraw_boundary_cases(amount, should_succeed):
    account = {"id": 1, "balance": 100.0}
    result = withdraw(account, amount)
    assert result["success"] is should_succeed
```

## Testing Immutability

```python
from dataclasses import FrozenInstanceError

def test_frozen_dataclass_prevents_mutation():
    user = User(name="Alice", email="alice@test.com")
    with pytest.raises(FrozenInstanceError):
        user.name = "Bob"

def test_replace_returns_new_instance():
    original = User(name="Alice", email="alice@test.com")
    updated = replace(original, email="new@test.com")

    assert updated.email == "new@test.com"
    assert original.email == "alice@test.com"  # Unchanged
    assert original is not updated  # Different objects

def test_dict_immutability_pattern():
    original = {"name": "Alice", "age": 30}
    updated = {**original, "age": 31}

    assert updated["age"] == 31
    assert original["age"] == 30  # Unchanged
```

## Testing Generators and Lazy Pipelines

```python
def test_generator_pipeline():
    data = ["  Alice  ", "", "  Bob  ", "  ", "  Carol  "]

    def clean(lines):
        for line in lines:
            stripped = line.strip()
            if stripped:
                yield stripped

    def upper(lines):
        for line in lines:
            yield line.upper()

    result = list(upper(clean(data)))
    assert result == ["ALICE", "BOB", "CAROL"]

def test_generator_is_lazy():
    call_count = 0

    def counting_transform(items):
        nonlocal call_count
        for item in items:
            call_count += 1
            yield item * 2

    gen = counting_transform([1, 2, 3, 4, 5])
    assert call_count == 0  # Nothing executed yet

    first = next(gen)
    assert first == 2
    assert call_count == 1  # Only one item processed
```

## Testing Data Pipelines (pandas)

```python
import pandas as pd
import pytest

@pytest.fixture
def sample_df():
    return pd.DataFrame({
        "name": ["  Alice  ", "Bob", None, "Carol"],
        "age": [25, 30, 35, 40],
        "email": ["a@test.com", None, "c@test.com", "d@test.com"],
    })

def test_clean_nulls(sample_df):
    result = clean_nulls(sample_df)
    assert len(result) == 2  # Only rows with both name and email
    assert result["name"].isna().sum() == 0
    assert result["email"].isna().sum() == 0

def test_normalize_names(sample_df):
    result = normalize_names(sample_df.dropna(subset=["name"]))
    assert list(result["name"]) == ["Alice", "Bob", "Carol"]

def test_pipeline_composition(sample_df):
    """Test the full pipeline produces expected shape."""
    result = (
        sample_df
        .pipe(clean_nulls)
        .pipe(normalize_names)
    )
    assert "name" in result.columns
    assert result["name"].str.strip().equals(result["name"])  # No whitespace
```

## Property-Based Testing with Hypothesis

```python
from hypothesis import given, strategies as st

# Pure functions enable property-based testing naturally
@given(st.lists(st.floats(min_value=0, max_value=10000, allow_nan=False)))
def test_calculate_total_non_negative(prices):
    items = [{"price": p} for p in prices]
    total = calculate_total(items)
    assert total >= 0

@given(st.text(), st.text())
def test_concat_length(a, b):
    result = concat(a, b)
    assert len(result) == len(a) + len(b)

@given(
    st.dictionaries(st.text(min_size=1), st.integers()),
    st.dictionaries(st.text(min_size=1), st.integers()),
)
def test_merge_dicts_contains_all_keys(d1, d2):
    result = merge_dicts(d1, d2)
    assert all(k in result for k in d1)
    assert all(k in result for k in d2)

# Roundtrip properties
@given(st.builds(User, name=st.text(min_size=1), email=st.emails()))
def test_user_serialization_roundtrip(user):
    serialized = user_to_dict(user)
    deserialized = user_from_dict(serialized)
    assert deserialized == user
```

## Testing Side Effect Isolation

```python
def test_pure_core_without_mocking():
    """Pure functions need no mocks — just pass data in, check data out."""
    order = {"items": [{"price": 10, "qty": 2}], "discount_code": "SAVE10"}
    discount_table = {"SAVE10": 0.10}

    total = calculate_order_total(order["items"], tax_rate=0.0)
    final = apply_discount(total, order["discount_code"], discount_table)

    assert final == 18.0  # 20 - 10%

def test_shell_with_minimal_mocking():
    """Shell tests need mocks, but they're thin."""
    mock_db = Mock()
    mock_db.get_tax_rate.return_value = 0.0
    mock_db.get_discount_table.return_value = {}
    mock_payment = Mock()
    mock_payment.charge.return_value = {"success": True}
    mock_logger = Mock()

    result = process_order(
        {"items": [{"price": 10, "qty": 1}], "region": "US", "customer_id": 1},
        db=mock_db,
        payment_gateway=mock_payment,
        logger=mock_logger,
    )

    assert result["success"]
    mock_db.save_order.assert_called_once()
```

## Fixtures for FP Testing

```python
@pytest.fixture
def make_user():
    """Factory fixture — returns a function for creating test users."""
    def _make(name="Test User", email="test@example.com", **overrides):
        return User(name=name, email=email, **overrides)
    return _make

def test_update_email(make_user):
    user = make_user(email="old@test.com")
    updated = update_email(user, "new@test.com")
    assert updated.email == "new@test.com"

@pytest.fixture
def sample_items():
    """Reusable test data — immutable tuple."""
    return (
        {"id": 1, "name": "Widget", "price": 10.0, "category": "A"},
        {"id": 2, "name": "Gadget", "price": 25.0, "category": "B"},
        {"id": 3, "name": "Doohickey", "price": 5.0, "category": "A"},
    )
```

## Test Organization

```
tests/
  test_core/          # Pure function tests (no mocks)
    test_calculations.py
    test_validations.py
    test_transformations.py
  test_shell/         # Integration tests (minimal mocks)
    test_order_service.py
    test_api_handlers.py
  test_pipelines/     # Data pipeline tests
    test_etl.py
    test_features.py
  conftest.py         # Shared fixtures
```

**Key insight**: The pure core tests should be the majority (80%+) and run fast with no I/O. Shell tests are fewer and may need mocks or test databases.
