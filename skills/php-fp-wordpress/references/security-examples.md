# WordPress Security Patterns: Cumulative Boundaries

These examples apply the baseline in
[ima-security-guardrails](../../ima-security-guardrails/SKILL.md). Each control is necessary for
its own purpose: validation, sanitization, authorization, CSRF protection, parameterization, and
contextual encoding are not interchangeable.

## 1. Privileged AJAX: complete handler boundary

This handler updates only a post the current user may edit. It validates the resource identifier,
verifies the request intent, authorizes that specific resource, normalizes the input, and returns
JSON data rather than pre-escaped HTML.

```php
<?php
declare(strict_types=1);

add_action('wp_ajax_ima_update_post_title', 'ima_update_post_title');

function ima_update_post_title(): void {
    check_ajax_referer('ima_update_post_title', 'nonce');

    $post_id = absint(wp_unslash($_POST['post_id'] ?? ''));
    if ($post_id === 0 || get_post($post_id) === null) {
        wp_send_json_error(['message' => 'Invalid post.'], 400);
    }

    if (!current_user_can('edit_post', $post_id)) {
        wp_send_json_error(['message' => 'Forbidden.'], 403);
    }

    $title = sanitize_text_field(wp_unslash($_POST['title'] ?? ''));
    if ($title === '') {
        wp_send_json_error(['message' => 'Title is required.'], 422);
    }

    $result = wp_update_post(['ID' => $post_id, 'post_title' => $title], true);
    if (is_wp_error($result)) {
        wp_send_json_error(['message' => 'Update failed.'], 500);
    }

    wp_send_json_success(['postId' => $post_id, 'title' => $title]);
}
```

Do not add a matching `wp_ajax_nopriv_` action for this privileged operation. A nonce proves neither
identity nor `edit_post` authority, and UI visibility is not a server-side check.

## 2. Intentional public AJAX: bounded read-only behavior

A public endpoint must be intentional, read-only or otherwise product-controlled, and safe even
when called directly. This isolated example does not claim that its response limit is an abuse
control; add rate limits or challenge controls when the exposure requires them.

```php
<?php
declare(strict_types=1);

add_action('wp_ajax_nopriv_ima_public_topic_lookup', 'ima_public_topic_lookup');
add_action('wp_ajax_ima_public_topic_lookup', 'ima_public_topic_lookup');

function ima_public_topic_lookup(): void {
    $term = sanitize_text_field(wp_unslash($_GET['term'] ?? ''));
    if ($term === '' || strlen($term) > 64) {
        wp_send_json_error(['message' => 'Invalid search term.'], 400);
    }

    $query = new WP_Query([
        's' => $term,
        'post_type' => 'post',
        'post_status' => 'publish',
        'posts_per_page' => 10,
        'no_found_rows' => true,
    ]);

    $items = array_map(
        static fn (WP_Post $post): array => ['id' => $post->ID, 'title' => get_the_title($post)],
        $query->posts,
    );

    wp_send_json_success(['items' => $items]);
}
```

The browser must render `title` using a text sink. Do not expose drafts, private metadata, user
records, tokens, or privilege-changing actions through a public handler.

## 3. REST: authorization belongs in `permission_callback`

Route registration and a logged-in cookie do not authorize a resource update. The callback below
makes the decision before the REST callback performs the effect.

```php
<?php
declare(strict_types=1);

add_action('rest_api_init', static function (): void {
    register_rest_route('ima/v1', '/posts/(?P<id>\d+)/label', [
        'methods' => WP_REST_Server::EDITABLE,
        'permission_callback' => static function (WP_REST_Request $request): bool {
            return current_user_can('edit_post', absint($request['id']));
        },
        'args' => [
            'label' => ['required' => true, 'type' => 'string'],
        ],
        'callback' => 'ima_update_post_label',
    ]);
});

function ima_update_post_label(WP_REST_Request $request): WP_REST_Response {
    $post_id = absint($request['id']);
    $label = sanitize_text_field((string) $request['label']);
    if ($label === '') {
        return new WP_REST_Response(['message' => 'Label is required.'], 422);
    }

    update_post_meta($post_id, '_ima_label', $label);
    return new WP_REST_Response(['postId' => $post_id, 'label' => $label], 200);
}
```

Validate route arguments and authorize the exact resource. If a route is intentionally public,
state why and ensure its response only contains public data.

## 4. Database values and dynamic structure

Use `$wpdb->prepare()` for values. Placeholders cannot bind a column, table, or sort direction, so
select those from fixed code or an allowlist.

```php
<?php
declare(strict_types=1);

function ima_find_records(string $status, string $requested_sort): array {
    global $wpdb;

    $allowed_sorts = ['created_at', 'title'];
    if (!in_array($requested_sort, $allowed_sorts, true)) {
        return [];
    }

    $table = $wpdb->prefix . 'ima_records';
    $sql = $wpdb->prepare(
        "SELECT id, title FROM {$table} WHERE status = %s ORDER BY {$requested_sort}",
        $status,
    );

    return $wpdb->get_results($sql, ARRAY_A);
}
```

The WordPress prefix and `$allowed_sorts` are code-controlled. Never derive either structural
fragment from a request value. Sanitization does not replace prepared values.

## 5. Output: use the final sink's context

`wp_kses_post()` applies a particular HTML allowlist; it does **not** make data generally safe for
all contexts. Escape at the sink instead:

```php
<?php
echo '<h2>' . esc_html($record['title']) . '</h2>';
echo '<a href="' . esc_url($record['url']) . '">Read more</a>';
echo '<div data-record="' . esc_attr((string) $record['id']) . '"></div>';
echo '<script>window.imaRecord = ' . wp_json_encode($record) . ';</script>';
```

Deliberate rich HTML needs a reviewed `wp_kses()` policy that matches the intended markup. Never
pass arbitrary user content to a browser HTML sink merely because it was sanitized for storage.

## 6. Files and paths: authorize, constrain, and verify

This handler is complete for an authenticated image-upload boundary. It still needs product-specific
storage retention and malware-scanning policy where those are required.

```php
<?php
declare(strict_types=1);

function ima_upload_logo(): void {
    check_ajax_referer('ima_upload_logo', 'nonce');

    if (!current_user_can('upload_files')) {
        wp_send_json_error(['message' => 'Forbidden.'], 403);
    }

    $file = $_FILES['logo'] ?? null;
    if (!is_array($file) || ($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
        wp_send_json_error(['message' => 'Upload failed.'], 400);
    }

    $upload = wp_handle_upload($file, [
        'test_form' => false,
        'mimes' => ['jpg|jpeg' => 'image/jpeg', 'png' => 'image/png'],
    ]);

    if (isset($upload['error'])) {
        wp_send_json_error(['message' => 'Unsupported upload.'], 422);
    }

    wp_send_json_success(['url' => esc_url_raw($upload['url'])]);
}
```

Do not let a client choose an arbitrary local path. Constrain filesystem effects to an approved base,
validate the effective path, and account for traversal and symlink behavior in sensitive operations.

## 7. Redirects and outbound HTTP: destination is a boundary

For a redirect, prefer a fixed local destination. When a user-controlled return target is a product
requirement, validate it and use a safe fallback:

```php
$requested = esc_url_raw(wp_unslash($_GET['return_to'] ?? ''));
$target = wp_validate_redirect($requested, admin_url('admin.php?page=ima'));
wp_safe_redirect($target);
exit;
```

For server-side HTTP, accept only an approved HTTPS host and disable unneeded redirects. This
isolated request boundary must not forward credentials to the remote destination.

```php
function ima_fetch_status(string $url): array {
    $parts = wp_parse_url($url);
    $allowed_host = 'status.example.org';

    if (!is_array($parts)
        || ($parts['scheme'] ?? '') !== 'https'
        || ($parts['host'] ?? '') !== $allowed_host
        || (isset($parts['port']) && $parts['port'] !== 443)
        || isset($parts['user'])
        || isset($parts['pass'])) {
        return ['success' => false, 'error' => 'Destination not allowed'];
    }

    $response = wp_remote_get($url, ['timeout' => 5, 'redirection' => 0]);
    if (is_wp_error($response) || wp_remote_retrieve_response_code($response) !== 200) {
        return ['success' => false, 'error' => 'Status unavailable'];
    }

    return ['success' => true, 'body' => wp_remote_retrieve_body($response)];
}
```

For higher-risk SSRF surfaces, use a product-approved network policy that accounts for DNS and
private-network reachability rather than expanding this example into an ad-hoc network filter.

## 8. Sensitive data and supply chain

- Keep credentials, tokens, personal data, raw uploads, SQL, and request bodies out of logs and
  error responses. Return a bounded public error and keep internal diagnostics access-controlled.
- Store secrets in deployment-controlled configuration and fail closed when required secrets are
  absent. Do not localize them into browser JavaScript or expose them through options APIs.
- Review plugin, Composer, and npm dependency changes, lockfiles, source provenance, and required
  permissions before updating. A trusted package name is not an authorization boundary.
- Test each enforcement point: denied capability, invalid or missing nonce, hostile input at the
  actual query/output/file/network sink, and an explicit fail-closed result.
