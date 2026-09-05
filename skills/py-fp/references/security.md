# Python boundary security

Apply [ima-security-guardrails](../../ima-security-guardrails/SKILL.md) at the effectful boundary.
Validation, authorization, parameterization, output encoding, and secret handling are distinct
controls. Pure functions should receive validated values and return data; handlers own I/O and fail
closed when a required check cannot be established.

## Database parameters

Never interpolate external values into SQL. Use the placeholder style documented by the installed
DB-API driver and pass values separately. Placeholders bind values, not table names or sort order.

```python
# The placeholder style is driver-specific; this example uses a DB-API sequence parameter.
def find_user_by_email(email: str, connection):
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT id, email FROM users WHERE email = %s",
            [email],
        )
        return cursor.fetchone()
```

Map dynamic identifiers or sort direction to a fixed allowlist before constructing query structure.
Authorize the caller before executing a query that accesses protected records.

## Commands and paths

Use argument arrays and `shell=False`, but do not mistake that for complete command safety. Resolve
and constrain every user-selected path before execution, reject option-like names, and use a fixed
or allowlisted executable. `shell=False` prevents shell parsing; it does not stop the executable from
interpreting an option-like argument.

```python
from pathlib import Path
import subprocess

CONVERT_EXECUTABLE = "/usr/bin/convert"
INPUT_BASE = Path("/srv/imports").resolve()
OUTPUT_BASE = Path("/srv/exports").resolve()
ALLOWED_IMAGE_SUFFIXES = frozenset({".jpg", ".jpeg", ".png"})

def resolve_approved_path(relative_name: str, base: Path) -> Path:
    if not isinstance(relative_name, str) or not relative_name:
        raise ValueError("A file name is required")

    candidate = (base / relative_name).resolve(strict=False)
    if candidate == base or base not in candidate.parents:
        raise ValueError("Path is outside the approved directory")
    if candidate.name.startswith("-"):
        raise ValueError("Option-like file names are not allowed")
    if candidate.suffix.lower() not in ALLOWED_IMAGE_SUFFIXES:
        raise ValueError("Unsupported image type")
    return candidate

def convert_image(input_filename: str, output_filename: str) -> dict:
    input_path = resolve_approved_path(input_filename, INPUT_BASE)
    output_path = resolve_approved_path(output_filename, OUTPUT_BASE)

    try:
        completed = subprocess.run(
            [CONVERT_EXECUTABLE, str(input_path), str(output_path)],
            shell=False,
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError:
        return {"success": False, "error": "Conversion unavailable"}

    if completed.returncode != 0:
        return {"success": False, "error": "Conversion failed"}
    return {"success": True, "output": output_path.name}
```

Only the fixed executable and approved absolute paths reach `subprocess.run()`. The bounded failure
results intentionally omit captured output, paths, and exception details. A path check alone does
not eliminate time-of-check/time-of-use or symlink risks for a sensitive operation. Use an OS- and
deployment-appropriate no-follow or directory-descriptor strategy when that risk applies.

## Parsing, output, and secrets

Use `json.loads` for JSON and `yaml.safe_load` for untrusted YAML. Never use `pickle`, `eval`, or
unsafe object deserialization on untrusted data. Validate the resulting shape before business logic.

Encode output for its final context. For example, use `html.escape` for HTML text and validate scheme
and destination before rendering or following a URL. A validated string is not automatically safe
for HTML, a command, a path, or a log.

Read required secrets from an injected configuration source or `os.environ` and fail closed when
missing. Do not echo credentials, raw tokens, sensitive records, query text, or stack traces to a
client or shared log.

```python
import os

api_key = os.environ["API_KEY"]  # Missing configuration raises instead of guessing a default.
```

## Negative evidence

Test denied authorization, malformed and injection-shaped input at the real sink, disallowed paths
and command arguments, failed parsing, missing secrets, and encoded output. A pure validator test is
not proof that a database, browser, filesystem, or subprocess boundary is protected.
