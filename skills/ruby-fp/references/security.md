# Ruby Boundary Security

This reference operationalizes the shared [IMA security guardrails](../../ima-security-guardrails/SKILL.md) for Ruby. Keep its SQL, shell, path, parsing, secret, and output guidance aligned with that baseline.

Treat validation and effects as a boundary: normalize and validate untrusted input in the imperative shell, pass validated values to the pure core, encode for the output context, and exclude secrets from errors and logs. Validation does not replace parameterization, escaping, authorization, or capability checks.

## SQL and shell execution

Never concatenate or interpolate untrusted values into SQL. Use the documented bind/placeholder API of the installed adapter.

```ruby
# Unsafe: db.execute("SELECT * FROM users WHERE email = '#{email}'")
rows = db.exec_params("SELECT * FROM users WHERE email = $1", [email])

# Unsafe: system("convert #{filename} output.png")
stdout, stderr, status = Open3.capture3("convert", filename, "output.png")
```

An argument vector prevents shell parsing, but validate `filename` and check `status` too.

## Validation, paths, and parsing

Use explicit parsers and allowlists. Keep syntax validation separate from authorization; reject partial data with explicit errors.

```ruby
base = Pathname("/srv/imports").realpath
candidate = base.join(relative_name).cleanpath
raise "outside approved base" unless candidate.to_s.start_with?("#{base}/")
```

Filename sanitization is not authorization. Sensitive filesystem operations also need symlink-aware handling and an authorization decision. Parse JSON with `JSON.parse`; never use unsafe object deserialization. Use only documented safe-mode YAML/object-loading contracts for the installed Ruby version.

## Secrets and output

Obtain secrets with `ENV.fetch` or an injected source, fail closed when missing, and never print them:

```ruby
api_key = ENV.fetch("API_KEY")
```

Encode output for its exact HTML, URL, JSON, or other context. Error messages and logs must not leak credentials, raw SQL, command strings, stack traces, or sensitive paths.
