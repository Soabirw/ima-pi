# WordPress security testing

Use these examples with the smallest WordPress-aware test level that can observe the enforcement
point. They complement pure unit tests; they do not move authorization, nonce, database, or output
wrapper behavior into a sink-free unit suite. Apply
[ima-security-guardrails](../../ima-security-guardrails/SKILL.md) for the control definitions.

## What the test must observe

| Boundary | Observable outcome |
| --- | --- |
| Privileged AJAX / REST | Missing or invalid nonce where applicable, and denied resource capability, prevent the effect |
| Request input | Malformed or hostile input returns a bounded validation failure |
| Database | The executing path passes values through `$wpdb->prepare()` or the installed safe API |
| Output | Untrusted data is encoded at the actual HTML, attribute, URL, JSON, or rich-HTML sink |
| Failure | Missing, ambiguous, or unavailable required state fails closed without leaking data |

## Pure validation remains a unit test

Test pure logic directly, including hostile-looking values, but name it accurately. It proves the
rule, not an output or query sink.

```php
<?php
public function test_label_validator_rejects_empty_or_overlong_input(): void {
    self::assertSame(
        ['valid' => false, 'error' => 'Label is required'],
        ima_validate_label_pure(''),
    );

    self::assertFalse(ima_validate_label_pure(str_repeat('x', 501))['valid']);
}
```

## Nonce and capability denial belong to a wrapper test

In a configured WordPress integration harness, dispatch the real handler and assert that its effect
did not run. The exact dispatch helper is project-specific; do not invent an AJAX bootstrap only for
a unit test.

```php
<?php
public function test_update_handler_rejects_a_missing_nonce(): void {
    $response = $this->dispatch_privileged_ajax('ima_update_post_title', [
        'post_id' => '42',
        'title' => 'New title',
        // Deliberately no nonce.
    ]);

    self::assertSame(403, $response->get_status());
    self::assertFalse($this->post_title_was_updated(42));
}

public function test_update_handler_denies_a_user_without_post_capability(): void {
    $this->login_as($this->create_user(['role' => 'subscriber']));

    $response = $this->dispatch_privileged_ajax('ima_update_post_title', [
        'post_id' => '42',
        'title' => 'New title',
        'nonce' => wp_create_nonce('ima_update_post_title'),
    ]);

    self::assertSame(403, $response->get_status());
    self::assertFalse($this->post_title_was_updated(42));
}
```

A public handler has different evidence: it must be intentionally public, return only public data,
and reject malformed or abusive input according to the product's controls. Do not add a capability
assertion merely to make an intentional public read endpoint look privileged.

## Prepared-query integration

Test the path that constructs and executes the query, not a string formatter that never reaches the
database boundary. A project may use a `$wpdb` spy in an integration fixture or a safe disposable
local database; preserve the existing test infrastructure.

```php
<?php
public function test_record_lookup_prepares_a_dynamic_status_value(): void {
    $wpdb = $this->wpdb_spy();
    $wpdb->expects(self::once())
        ->method('prepare')
        ->with(
            self::stringContains('WHERE status = %s'),
            "' OR 1=1 --",
        );

    ima_find_records("' OR 1=1 --", 'created_at');
}
```

Also test unsupported dynamic identifiers or sort direction: they should return a failure or safe
empty result before a query is executed. Placeholders do not bind SQL structure.

## Output and URL sinks

Exercise the actual renderer or template helper. The expected output depends on its sink:

```php
<?php
public function test_profile_renderer_escapes_html_text(): void {
    $html = ima_render_profile(['name' => '<script>alert(1)</script>']);

    self::assertStringContainsString('&lt;script&gt;', $html);
    self::assertStringNotContainsString('<script>', $html);
}

public function test_redirect_rejects_an_unapproved_destination(): void {
    self::assertSame(
        admin_url('admin.php?page=ima'),
        ima_validate_return_to('https://untrusted.example/'),
    );
}
```

Use a distinct test for approved rich HTML, URL attributes, JSON, uploads, paths, and outbound HTTP
when those sinks exist. `wp_kses_post()` does not prove a URL or JavaScript context is safe.

## Fail-closed cases

Include a bounded result for missing required configuration, a failed remote response, a disallowed
MIME type, an invalid path, or an unverifiable state where the feature has that boundary. Assert that
the effect did not occur and that a response or log does not expose a credential, token, raw query,
or sensitive record.

Run the existing suite and report the harness used. If the project has no supported integration
environment, record that limitation rather than claiming nonce, capability, or `$wpdb` behavior from
pure tests.
