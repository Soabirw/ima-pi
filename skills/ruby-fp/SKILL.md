---
name: "ruby-fp"
description: "Functional Ruby patterns - Enumerable as FP toolkit, lambdas, freeze, functional core/imperative shell"
---

# Ruby FP

Ruby is OOP-first, but its FP toolkit is excellent. Goal: **functional core, imperative shell** — pure methods for logic, OOP shell only where the framework demands it.

## Core Rules

- **Pure methods** for logic — no instance variable mutation in calculation methods
- **Enumerable over explicit loops** — `map/select/reduce` not `each` + accumulator
- **Lambdas** (`->`) for first-class functions — strict arity, scoped `return`
- **freeze** for value objects and constants
- **Functional core** isolated from I/O, database, external state

## Enumerable: Primary Tools

```ruby
users = [
  { name: 'Alice', age: 30, active: true },
  { name: 'Bob',   age: 17, active: false },
  { name: 'Carol', age: 25, active: true }
]

adults       = users.select { |u| u[:age] >= 18 }
names        = users.map { |u| u[:name] }
total_age    = users.reduce(0) { |sum, u| sum + u[:age] }
active_names = users.filter_map { |u| u[:name] if u[:active] }  # Ruby 2.7+, preferred
tags         = posts.flat_map { |p| p[:tags] }
index        = users.each_with_object({}) { |u, h| h[u[:name]] = u[:age] }
by_status    = users.group_by { |u| u[:active] ? :active : :inactive }

# Functional pipeline
result = users
  .select { |u| u[:active] }
  .map { |u| u.merge(display_name: u[:name].upcase) }
  .sort_by { |u| u[:age] }
```

If writing `results = []; collection.each { |x| results << x if ... }` — use `filter_map` instead.

## Lambdas vs Procs

```ruby
validate_age   = ->(age) { age.is_a?(Integer) && age >= 0 && age <= 150 }
normalize_email = ->(email) { email.to_s.strip.downcase }

# Compose with >> (Ruby 2.6+)
process_user = normalize_email >> method(:save_user)

# Higher-order functions
def transform_all(items, transformer) = items.map(&transformer)
transform_all(emails, normalize_email)

# Method references
emails.map(&method(:normalize_email))
```

| | Lambda | Proc |
|-|--------|------|
| Arity | Strict (raises ArgumentError) | Loose (fills nil) |
| `return` | Exits lambda only | Exits enclosing method |
| Use for | Reusable functions, composition | Blocks, iterators |

## Immutability with freeze

```ruby
VALID_STATUSES = %w[active inactive pending].freeze
DEFAULT_CONFIG = { timeout: 30, retries: 3 }.freeze

# Value object — Ruby 3.2+
UserRecord = Data.define(:name, :email, :age)
user = UserRecord.new(name: 'Alice', email: 'alice@example.com', age: 30)

# Older Ruby
Config = Struct.new(:host, :port, :timeout).new('localhost', 5432, 30).freeze
```

Any hash/array constant gets `.freeze`. Value objects use `Data.define` (3.2+) or frozen `Struct`.

## Functional Core / Imperative Shell

```ruby
# PURE CORE — no I/O, fully testable
module UserLogic
  def self.validate(attrs)
    errors = []
    errors << "Name required" if attrs[:name].to_s.strip.empty?
    errors << "Invalid email" unless attrs[:email].to_s.include?('@')
    errors << "Age must be 18+" if attrs[:age].to_i < 18
    errors
  end

  def self.normalize(attrs)
    attrs.merge(name: attrs[:name].to_s.strip, email: attrs[:email].to_s.strip.downcase)
  end

  def self.prepare_for_save(raw_attrs)
    normalized = normalize(raw_attrs)
    errors = validate(normalized)
    errors.empty? ? { ok: true, attrs: normalized } : { ok: false, errors: errors }
  end
end

# IMPERATIVE SHELL — orchestrates I/O, calls pure core
def create_user(raw_params)
  result = UserLogic.prepare_for_save(raw_params)
  return { success: false, errors: result[:errors] } unless result[:ok]
  user = User.create!(result[:attrs])
  { success: true, user: user }
end
```

## Pure Method: Good vs Bad

```ruby
# BAD — mutates instance variables during calculation
def calculate_totals
  @subtotal = @items.sum { |i| i[:price] * i[:qty] }
  @tax = @subtotal * 0.08
  @total = @subtotal + @tax
end

# GOOD — returns new values, no mutation
def self.calculate_totals(items, tax_rate: 0.08)
  subtotal = items.sum { |i| i[:price] * i[:qty] }
  tax = subtotal * tax_rate
  { subtotal: subtotal, tax: tax, total: subtotal + tax }
end
```

## Composition Patterns

```ruby
# Immutable pipeline
class Pipeline
  def initialize(steps = []) = @steps = steps.freeze
  def add(step) = Pipeline.new(@steps + [step])
  def call(input) = @steps.reduce(input) { |data, step| step.call(data) }
end

# Lambda composition
sanitize  = ->(s) { s.strip.downcase }
validate  = ->(s) { raise "empty" if s.empty?; s }
normalize = sanitize >> validate

# Callable objects (duck-typed lambdas)
validators = [Validator.new, ->(v) { v.length < 255 }]
valid = validators.all? { |v| v.call(input) }
```

## Anti-Patterns

```ruby
# BAD — accumulator mutation
result = []
items.each { |item| result << transform(item) if item[:active] }
# GOOD
result = items.filter_map { |item| transform(item) if item[:active] }

# BAD — output parameter mutation
def process(items, output) = items.each { |i| output << i * 2 }
# GOOD
def process(items) = items.map { |i| i * 2 }

# BAD — mixed concerns
def calculate_and_save
  total = @items.sum(&:price); @total = total; DB.save(total); total
end
# GOOD
total = calculate_total(@items)   # pure
update_total(total)               # side effect isolated

# BAD — bare proc for reusable function
adder = proc { |a, b| a + b }
# GOOD
adder = ->(a, b) { a + b }
```

## When to Use Classes vs Modules

**Use classes for:** stateful entities (User, Order, Connection), framework integration (ActiveRecord), objects with lifecycle.

**Use modules with class methods for:** pure logic, utilities, transformations, validators.

```ruby
module PriceCalculator
  RATES = { bronze: 0.05, silver: 0.10, gold: 0.20 }.freeze
  def self.discount(price, tier) = price * (1 - RATES.fetch(tier, 0))
end

class ImportJob
  def initialize(source_db, config) = (@source_db, @config = source_db, config)
  def run = persist(process(fetch_records))
  private
  def process(records) = records.select { |r| valid?(r) }.map { |r| transform(r) }
end
```

## Security (Standalone Scripts)

```ruby
# BAD — shell injection
system("convert #{filename} output.png")
# GOOD — array form, no shell expansion
stdout, stderr, status = Open3.capture3('convert', filename, 'output.png')

# BAD — hardcoded credential
client = Mysql2::Client.new(password: 'secret123')
# GOOD — fail loudly if not set
client = Mysql2::Client.new(password: ENV.fetch('MYSQL_PASSWORD'))
```

- Never interpolate external input into shell commands
- Never interpolate input into SQL — use parameterized queries
- Use `ENV.fetch` for credentials — raises KeyError if missing

## Quick Reference

| Need | Use |
|------|-----|
| Transform collection | `map` |
| Filter collection | `select` / `reject` |
| Transform + filter | `filter_map` |
| Accumulate to single value | `reduce` / `inject` |
| Build hash from collection | `each_with_object` / `to_h` |
| Group by property | `group_by` |
| Reusable function | `lambda` / `->` |
| Compose functions | `>>` operator |
| Immutable constant | `.freeze` |
| Immutable value object | `Data.define` (Ruby 3.2+) or frozen `Struct` |
| Pure logic module | `module Foo; def self.method...` |

## Reference Files

- **[`references/patterns.md`](references/patterns.md)** — Lazy enumerables, currying, memoization, advanced composition. Load when: need advanced FP patterns.
- **[`references/security.md`](references/security.md)** — SQL parameterization, shell safety, input validation. Load when: working with external input.
