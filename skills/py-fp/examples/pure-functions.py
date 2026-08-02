"""
Pure Functions in Python — Working Examples

Demonstrates core FP patterns: purity, immutability, composition,
and the functional core / imperative shell architecture.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from functools import lru_cache, partial, reduce
from operator import itemgetter
from typing import NamedTuple


# === Immutable Data Structures ===

@dataclass(frozen=True)
class User:
    name: str
    email: str
    role: str = "user"
    settings: tuple = ()  # Tuple for deep immutability


class Point(NamedTuple):
    x: float
    y: float


# === Pure Functions: Calculations ===

def calculate_total(items: list[dict]) -> float:
    return sum(item["price"] * item.get("quantity", 1) for item in items)


def apply_discount(total: float, rate: float) -> float:
    clamped_rate = max(0.0, min(1.0, rate))
    return round(total * (1 - clamped_rate), 2)


def calculate_tax(subtotal: float, tax_rate: float) -> float:
    return round(subtotal * tax_rate, 2)


# === Pure Functions: Validation ===

def validate_required(value) -> bool:
    return value is not None and value != ""


def validate_email(value: str) -> bool:
    return isinstance(value, str) and "@" in value and "." in value.split("@")[-1]


def validate_length(min_len: int, max_len: int):
    return lambda value: isinstance(value, str) and min_len <= len(value) <= max_len


def validate_user_email(email: str) -> dict:
    if not validate_required(email):
        return {"valid": False, "error": "Required"}
    if not validate_email(email):
        return {"valid": False, "error": "Invalid email format"}
    if not validate_length(5, 254)(email):
        return {"valid": False, "error": "Email length out of range"}
    return {"valid": True}


# === Pure Functions: Transformations ===

def normalize_name(name: str) -> str:
    return " ".join(name.strip().split()).title()


def update_user_email(user: User, new_email: str) -> User:
    return replace(user, email=new_email)


def add_item(items: list[dict], new_item: dict) -> list[dict]:
    return [*items, new_item]


def remove_item(items: list[dict], item_id: int) -> list[dict]:
    return [item for item in items if item["id"] != item_id]


def update_item(items: list[dict], item_id: int, updates: dict) -> list[dict]:
    return [{**item, **updates} if item["id"] == item_id else item for item in items]


# === Memoization (Pure Functions Only) ===

@lru_cache(maxsize=128)
def fibonacci(n: int) -> int:
    if n < 2:
        return n
    return fibonacci(n - 1) + fibonacci(n - 2)


# === Composition Without Utilities ===

def process_order(order: dict, discount_table: dict, tax_rate: float) -> dict:
    """Pure order processing — no I/O, no side effects."""
    if not order.get("items"):
        return {"success": False, "error": "Order must have items"}

    subtotal = calculate_total(order["items"])
    discount_rate = discount_table.get(order.get("discount_code", ""), 0.0)
    discounted = apply_discount(subtotal, discount_rate)
    tax = calculate_tax(discounted, tax_rate)
    total = round(discounted + tax, 2)

    return {
        "success": True,
        "data": {
            "subtotal": subtotal,
            "discount": round(subtotal - discounted, 2),
            "tax": tax,
            "total": total,
        },
    }


# === Higher-Order Functions ===

def create_validator(rules: list[dict]) -> callable:
    """Factory: creates a reusable validator from rules."""
    def validate(value):
        errors = [rule["message"] for rule in rules if not rule["check"](value)]
        return {"valid": True} if not errors else {"valid": False, "errors": errors}
    return validate


# Pre-configured validators
validate_username = create_validator([
    {"check": validate_required, "message": "Username is required"},
    {"check": validate_length(3, 50), "message": "Username must be 3-50 characters"},
    {"check": lambda v: v.isalnum(), "message": "Username must be alphanumeric"},
])


# === Partial Application ===

multiply = lambda a, b: a * b
double = partial(multiply, 2)
triple = partial(multiply, 3)


# === Grouping and Sorting (Using operator module) ===

def group_by_key(items: list[dict], key: str) -> dict[str, list[dict]]:
    """Group items by a key value. Pure function."""
    sorted_items = sorted(items, key=itemgetter(key))
    result = {}
    for item in sorted_items:
        group = item[key]
        result[group] = [*result.get(group, []), item]
    return result


# === Generator Pipeline ===

def read_lines(text: str):
    for line in text.splitlines():
        stripped = line.strip()
        if stripped:
            yield stripped


def filter_comments(lines):
    for line in lines:
        if not line.startswith("#"):
            yield line


def parse_key_value(lines):
    for line in lines:
        if "=" in line:
            key, _, value = line.partition("=")
            yield key.strip(), value.strip()


def parse_config(text: str) -> dict:
    """Parse a simple key=value config from text. Pure, lazy pipeline."""
    return dict(parse_key_value(filter_comments(read_lines(text))))
