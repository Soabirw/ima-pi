"""Tests for pure function examples — no mocks needed."""
from __future__ import annotations

import pytest

# Assume pure_functions is importable (adjust path as needed)
from examples.pure_functions import (
    User,
    add_item,
    apply_discount,
    calculate_tax,
    calculate_total,
    create_validator,
    double,
    fibonacci,
    group_by_key,
    normalize_name,
    parse_config,
    process_order,
    remove_item,
    triple,
    update_item,
    update_user_email,
    validate_email,
    validate_length,
    validate_required,
    validate_user_email,
    validate_username,
)


# === Calculation Tests ===

class TestCalculateTotal:
    @pytest.mark.parametrize("items,expected", [
        ([{"price": 10, "quantity": 2}, {"price": 5, "quantity": 1}], 25.0),
        ([{"price": 100}], 100.0),  # Default quantity = 1
        ([], 0.0),
    ])
    def test_valid_inputs(self, items, expected):
        assert calculate_total(items) == expected


class TestApplyDiscount:
    @pytest.mark.parametrize("total,rate,expected", [
        (100.0, 0.1, 90.0),
        (100.0, 0.0, 100.0),
        (100.0, 1.0, 0.0),
        (100.0, -0.1, 100.0),   # Clamped to 0
        (100.0, 1.5, 0.0),      # Clamped to 1
        (0.0, 0.5, 0.0),
    ])
    def test_discount_calculation(self, total, rate, expected):
        assert apply_discount(total, rate) == expected


class TestCalculateTax:
    @pytest.mark.parametrize("subtotal,rate,expected", [
        (100.0, 0.08, 8.0),
        (100.0, 0.0, 0.0),
        (9.99, 0.0825, 0.82),
    ])
    def test_tax_calculation(self, subtotal, rate, expected):
        assert calculate_tax(subtotal, rate) == expected


# === Validation Tests ===

class TestValidateRequired:
    @pytest.mark.parametrize("value,expected", [
        ("hello", True),
        ("", False),
        (None, False),
        (0, True),       # Zero is a valid value
        (False, True),   # False is a valid value
    ])
    def test_required_validation(self, value, expected):
        assert validate_required(value) == expected


class TestValidateEmail:
    @pytest.mark.parametrize("value,expected", [
        ("user@example.com", True),
        ("a@b.c", True),
        ("invalid", False),
        ("@no-local.com", False),
        ("no-domain@", False),
        ("", False),
        (123, False),  # Non-string
    ])
    def test_email_validation(self, value, expected):
        assert validate_email(value) == expected


class TestValidateUserEmail:
    def test_valid_email(self):
        result = validate_user_email("user@example.com")
        assert result["valid"] is True

    def test_empty_email(self):
        result = validate_user_email("")
        assert result["valid"] is False
        assert result["error"] == "Required"

    def test_invalid_format(self):
        result = validate_user_email("notanemail")
        assert result["valid"] is False
        assert "format" in result["error"].lower()


# === Immutability Tests ===

class TestImmutability:
    def test_frozen_dataclass_prevents_mutation(self):
        user = User(name="Alice", email="alice@test.com")
        with pytest.raises(AttributeError):
            user.name = "Bob"

    def test_update_returns_new_instance(self):
        original = User(name="Alice", email="old@test.com")
        updated = update_user_email(original, "new@test.com")
        assert updated.email == "new@test.com"
        assert original.email == "old@test.com"
        assert original is not updated

    def test_add_item_does_not_mutate(self):
        original = [{"id": 1, "name": "A"}]
        result = add_item(original, {"id": 2, "name": "B"})
        assert len(result) == 2
        assert len(original) == 1  # Unchanged

    def test_remove_item_does_not_mutate(self):
        original = [{"id": 1}, {"id": 2}, {"id": 3}]
        result = remove_item(original, 2)
        assert len(result) == 2
        assert len(original) == 3  # Unchanged

    def test_update_item_does_not_mutate(self):
        original = [{"id": 1, "name": "Old"}]
        result = update_item(original, 1, {"name": "New"})
        assert result[0]["name"] == "New"
        assert original[0]["name"] == "Old"  # Unchanged


# === Composition Tests ===

class TestProcessOrder:
    def test_valid_order(self):
        order = {"items": [{"price": 100, "quantity": 1}]}
        result = process_order(order, discount_table={}, tax_rate=0.1)
        assert result["success"] is True
        assert result["data"]["subtotal"] == 100.0
        assert result["data"]["tax"] == 10.0
        assert result["data"]["total"] == 110.0

    def test_order_with_discount(self):
        order = {
            "items": [{"price": 100, "quantity": 1}],
            "discount_code": "SAVE10",
        }
        result = process_order(order, discount_table={"SAVE10": 0.1}, tax_rate=0.0)
        assert result["success"] is True
        assert result["data"]["total"] == 90.0

    def test_empty_order_fails(self):
        result = process_order({"items": []}, discount_table={}, tax_rate=0.1)
        assert result["success"] is False
        assert "items" in result["error"].lower()


# === Higher-Order Function Tests ===

class TestCreateValidator:
    def test_all_rules_pass(self):
        result = validate_username("alice42")
        assert result["valid"] is True

    def test_empty_value(self):
        result = validate_username("")
        assert result["valid"] is False
        assert any("required" in e.lower() for e in result["errors"])

    def test_too_short(self):
        result = validate_username("ab")
        assert result["valid"] is False


# === Partial Application Tests ===

class TestPartialApplication:
    def test_double(self):
        assert double(5) == 10

    def test_triple(self):
        assert triple(5) == 15


# === Memoization Tests ===

class TestFibonacci:
    @pytest.mark.parametrize("n,expected", [
        (0, 0), (1, 1), (2, 1), (10, 55), (20, 6765),
    ])
    def test_fibonacci(self, n, expected):
        assert fibonacci(n) == expected


# === Generator Pipeline Tests ===

class TestParseConfig:
    def test_simple_config(self):
        text = """
        # Database settings
        host = localhost
        port = 5432
        name = mydb
        """
        result = parse_config(text)
        assert result == {"host": "localhost", "port": "5432", "name": "mydb"}

    def test_empty_input(self):
        assert parse_config("") == {}

    def test_comments_and_blanks_skipped(self):
        text = "# comment\n\nkey = value\n# another comment"
        result = parse_config(text)
        assert result == {"key": "value"}


# === Grouping Tests ===

class TestGroupByKey:
    def test_group_items(self):
        items = [
            {"name": "A", "category": "x"},
            {"name": "B", "category": "y"},
            {"name": "C", "category": "x"},
        ]
        result = group_by_key(items, "category")
        assert len(result["x"]) == 2
        assert len(result["y"]) == 1

    def test_empty_list(self):
        assert group_by_key([], "category") == {}
