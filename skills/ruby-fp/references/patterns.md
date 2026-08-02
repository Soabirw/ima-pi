# Advanced Ruby Functional Patterns

Use these Ruby-native patterns only when they make a concrete transformation clearer. Ruby should not imitate Haskell: **Simple > Complex** and **Evidence > Assumptions** still apply. The fundamentals remain in [`../SKILL.md`](../SKILL.md).

## Lazy enumerators

Use `Enumerable#lazy` when a large or unbounded source can stay lazy until a finite terminator consumes it. Keep I/O at the shell boundary and transformations pure.

```ruby
first_ten = records.lazy
  .select { |record| record[:active] }
  .map { |record| record[:email].downcase }
  .take(10)
  .force
```

Terminate intentionally with `first`, `take`, or `force`. Do not accidentally realize an entire stream with `to_a` before it is needed.

## Native composition and currying

Compose small lambdas or method objects with Ruby's `>>` or `<<`. Prefer explicit intermediate names once a chain hides the business rule; do not introduce custom `pipe` or `compose` helpers.

```ruby
normalize = ->(value) { value.to_s.strip.downcase }
valid_email = ->(value) { value.include?("@") ? { ok: true, value: value } : { ok: false, error: "invalid email" } }
process = normalize >> valid_email

multiply = ->(left, right) { left * right }
double = multiply.curry[2]
```

Use built-in `Proc#curry` only for a concrete partial application such as `double`; reject currying used only for style.

## Controlled memoization and immutable pipelines

Memoize only stable, pure inputs. Hidden I/O and stateful business rules do not belong in memoization. Put a shared cache lifetime at the shell boundary and inject it rather than using globals.

```ruby
class Pipeline
  def initialize(steps = []) = @steps = steps.freeze
  def add(step) = Pipeline.new(@steps + [step])
  def call(input) = @steps.reduce(input) { |value, step| step.call(value) }
end

cache = {}
lookup = ->(key, calculate) { cache.fetch(key) { cache[key] = calculate.call(key) } }
```

`add` returns a new pipeline and never mutates caller-owned steps.

## Callable dependencies and explicit results

Lambdas, method objects, and objects implementing `call` are interchangeable dependencies. Pass effects to the imperative shell; keep the core deterministic. Return ordinary hashes or small frozen values for expected outcomes instead of driving normal flow with exceptions.

```ruby
validate = ->(input) { input.empty? ? { ok: false, error: "required" } : { ok: true, value: input } }
notify = ->(message) { warn(message) } # shell dependency
```

Avoid custom FP utility suites, opaque clever chains, stateful business-rule memoization, accidental realization, and aesthetic currying.
