---
name: ima-security-guardrails
description: Apply IMA security guardrails to WordPress/PHP, JavaScript/TypeScript, and documentation examples that handle boundary data, authorization, persistence, or output.
---

# IMA security guardrails

## Security posture and intended use

Use this skill when a change accepts, transforms, stores, authorizes, sends, or renders data across a trust boundary. **All boundary data is untrusted** until the receiving boundary verifies what it needs. That includes HTTP requests, browser state, files, URLs, database records, queue messages, environment-derived configuration, and third-party responses.

This is the canonical cross-language security baseline for development, testing, review, and workflow guidance. Domain skills operationalize it for their framework or sink; they must not treat one control as a substitute for another.

## Trust boundaries and distinct controls

Keep these controls distinct and cumulative:

| Control                      | Decides                                                                       | Does not replace                                              |
|------------------------------|-------------------------------------------------------------------------------|---------------------------------------------------------------|
| Validation                   | Whether data has the expected shape, type, range, and allowed values          | Authorization, sanitization, encoding, or parameterization    |
| Sanitization / normalization | How accepted data is reduced to an intended representation                    | Authorization or context-specific output encoding             |
| Authentication               | Who presented a credential                                                    | Authorization for a resource or operation                     |
| Authorization                | Whether that principal may perform this operation on this resource            | Authentication, validation, or CSRF protection                |
| CSRF protection              | Whether a browser request was intentionally initiated in the expected session | Authorization or input validation                             |
| Contextual encoding          | How data is represented at a specific output sink                             | Validation, sanitization, or authorization                    |
| Parameterization             | How dynamic values reach an interpreter such as SQL                           | Allowlists for dynamic identifiers, paths, hosts, or commands |

Check authorization at the operation and resource boundary. Route access, UI visibility, a logged-in session, or nonce possession does not prove authority. Prefer narrow capabilities, least privilege, secure defaults, and reduced attack surface over broad access and post-hoc filtering.

## Sink-control matrix

Use the native safe API for the actual sink. Validate and allowlist dynamic structure before building it.

| Sink                                         | Required control                                                                                        |
|----------------------------------------------|---------------------------------------------------------------------------------------------------------|
| HTML text / attributes                       | Encode for the exact HTML or attribute context; use a reviewed sanitizer only for deliberate rich HTML  |
| URLs, redirects, and `href` / `src`          | Validate scheme and destination; allowlist hosts or paths where the operation is sensitive              |
| SQL values                                   | Use the driver’s parameterized-query API with a separate params array                                   |
| SQL identifiers, sort direction, table names | Select only from a fixed allowlist; placeholders do not bind structure                                  |
| Shell commands                               | Use argument arrays with no shell; allowlist executable and constrained arguments                       |
| Files and paths                              | Canonicalize as appropriate, constrain to an approved base, and account for traversal and symlinks      |
| Logs and errors                              | Exclude credentials, tokens, raw secrets, sensitive records, and executable query or command text       |
| Outbound network requests                    | Validate destination and protocol, constrain redirects, timeouts, and response handling to the use case |

Do not interpolate external input into SQL, shell commands, paths, HTML, URLs, or other interpreters. Missing, malformed, ambiguous, unauthorized, or unverifiable input must **fail closed** where practical. Return a bounded error; do not continue with a guessed default or partial privileged action.

## Lifecycle evidence

- **Plan:** identify trust boundaries, protected operations, sinks, and non-goals.
- **Implementation:** preserve explicit boundary checks and keep pure rules separate from I/O.
- **Test:** include risk-appropriate hostile and failure cases, such as denial, malformed input, injection-shaped input, and fail-closed outcomes.
- **Review:** trace materially changed data from source to sink and verify the distinct controls at each boundary. Marker presence or a named helper is not behavioral evidence.
- **Resolution and closeout:** unresolved security findings continue through resolution and rereview; do not close them as style-only concerns.

## WordPress PHP

For each edited PHP file and handler, apply the controls that match the boundary:

1. AJAX handlers verify a nonce with `wp_verify_nonce()` or `check_ajax_referer()` before processing. Privileged operations additionally authorize the caller with `current_user_can()` against the affected resource. Intentional public handlers state why no capability check applies and still validate, rate-limit or otherwise constrain abuse as the product requires.
2. REST routes provide a meaningful `permission_callback`; route registration is not authorization.
3. Every `$wpdb` query with dynamic values uses `->prepare()`; never interpolate values into SQL. Dynamic identifiers and sort direction come from a fixed allowlist.
4. User input is validated and then sanitized at the boundary with the appropriate function, such as `sanitize_text_field()`, `absint()`, `sanitize_email()`, `wp_kses()`, or `esc_url_raw()` for storage.
5. Output is escaped for its context with `esc_html()`, `esc_attr()`, `esc_url()`, `wp_json_encode()`, or `wp_kses()` for approved rich HTML.
6. Each PHP source file declares `declare(strict_types=1);` immediately after its opening `<?php` tag.

Use `wp_handle_upload()` and explicit MIME and path constraints for uploads. Use `wp_safe_redirect()` or an allowlisted destination for redirects. Treat outbound HTTP, sensitive records, and dependency updates as separate boundaries rather than assuming a nonce or input sanitizer covers them.

Use `do_action()` or `apply_filters()` for cross-plugin extension points rather than probing another plugin with `function_exists()`.

## JavaScript and TypeScript

Never construct SQL by interpolating values into a query string. Use the driver’s parameterized-query API, for example a SQL string with placeholders and a separate `params` array. A `LIKE` value remains a value: include `%` in the bound parameter, not the SQL source. Allowlist dynamic SQL identifiers and sort direction.

Treat request data, credentials, authorization state, DOM input, URL targets, and external responses as explicit boundaries. Validate them before use, check authorization server-side for protected actions, and handle failures without exposing secrets. Prefer text APIs such as `textContent` or jQuery `.text()` for untrusted content. Deliberate HTML insertion requires a reviewed sanitizer and an explicit trust decision; validated URL-bearing attributes need scheme and destination rules.

## Functional boundaries and styling

Keep business rules pure where practical and isolate I/O at explicit boundaries. [functional-programmer](../functional-programmer/SKILL.md) owns general FP guidance; do not create custom `pipe()`, `compose()`, `curry()`, monad, security-wrapper, or policy-engine utilities for these controls.

Bootstrap classes, CSS, and visual styling are not security controls. Styling guidance may link here, but it must not imply that a utility class, component, or client-side presentation prevents a boundary failure.

## Durable references

Use current primary or framework documentation when a concrete API choice matters. These durable references explain the baseline concepts:

- [OWASP Application Security Verification Standard](https://owasp.org/www-project-application-security-verification-standard/)
- [OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/)
- [WordPress Plugin Handbook: Security](https://developer.wordpress.org/plugins/security/)
- [MDN Web Security](https://developer.mozilla.org/en-US/docs/Web/Security)

Security requirements are risk- and sink-specific. State an inapplicable section rather than silently treating it as passed.
