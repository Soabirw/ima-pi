# WordPress Security Patterns - Detailed Examples

## Table of Contents
1. [Capability Checks](#1-capability-checks)
2. [Nonce Verification](#2-nonce-verification)
3. [Input Sanitization](#3-input-sanitization)
4. [Output Escaping](#4-output-escaping)
5. [Prepared SQL Statements](#5-prepared-sql-statements)
6. [Security Function Reference](#security-function-reference)

---

## 1. Capability Checks

**Prevents 53% of XSS vulnerabilities.**

```php
<?php
// ALWAYS check permissions FIRST
add_action('wp_ajax_delete_user_data', 'handle_delete_user_data');
function handle_delete_user_data() {
    // Check capability before ANY operation
    if (!current_user_can('delete_users')) {
        wp_send_json_error('Insufficient permissions', 403);
        return;
    }

    // Then proceed
    delete_user_data($_POST['user_id']);
}

// NEVER allow operations without capability check
function delete_user_data_UNSAFE() {
    wp_delete_user($_POST['user_id']); // Any authenticated user can delete!
}
```

### Common Capabilities
| Capability | Use For |
|------------|---------|
| `manage_options` | Plugin settings, admin-only operations |
| `edit_posts` | Content creation |
| `delete_users` | User management |
| `upload_files` | File uploads |

---

## 2. Nonce Verification

**Prevents 15-17% CSRF attacks.**

```php
<?php
// ALWAYS verify nonces
add_action('admin_post_save_settings', 'save_plugin_settings');
function save_plugin_settings() {
    // Verify nonce before processing
    if (!isset($_POST['settings_nonce']) ||
        !wp_verify_nonce($_POST['settings_nonce'], 'save_settings_action')) {
        wp_die('Security check failed');
    }

    // Then save
    update_option('plugin_settings', $_POST['settings']);
}

// NEVER process forms without nonce
function save_settings_UNSAFE() {
    update_option('plugin_settings', $_POST['settings']); // CSRF vulnerable!
}
```

### Nonce Functions
| Function | Purpose |
|----------|---------|
| `wp_nonce_field('action', 'field_name')` | Generate hidden form field |
| `wp_verify_nonce($_POST['field'], 'action')` | Verify form submission |
| `check_ajax_referer('action', 'nonce')` | Verify AJAX nonce |
| `wp_create_nonce('action')` | Create nonce for JS |

---

## 3. Input Sanitization

**Required for ALL user input.**

```php
<?php
// ALWAYS sanitize based on data type
function process_form_submission() {
    $name = sanitize_text_field($_POST['name']);
    $email = sanitize_email($_POST['email']);
    $content = wp_kses_post($_POST['content']); // Allow safe HTML
    $url = esc_url_raw($_POST['website']);
    $number = absint($_POST['count']);

    save_to_database($name, $email, $content, $url, $number);
}

// NEVER use raw input
function process_form_UNSAFE() {
    save_to_database($_POST['name'], $_POST['email']); // Injection risk!
}
```

### Sanitization Functions
| Function | Use For |
|----------|---------|
| `sanitize_text_field()` | Plain text, single line |
| `sanitize_textarea_field()` | Multi-line text |
| `sanitize_email()` | Email addresses |
| `absint()` | Positive integers |
| `wp_kses_post()` | HTML (post content allowed tags) |
| `esc_url_raw()` | URLs for database storage |

---

## 4. Output Escaping

**Context-specific escaping required.**

```php
<?php
// ALWAYS escape based on context
function render_user_profile($user) {
    // HTML context
    echo '<h2>' . esc_html($user->name) . '</h2>';

    // Attribute context
    echo '<img src="' . esc_url($user->avatar) . '" alt="' . esc_attr($user->name) . '">';

    // JavaScript context
    echo '<script>var userName = ' . wp_json_encode($user->name) . ';</script>';

    // URL context
    echo '<a href="' . esc_url($user->website) . '">Website</a>';
}

// NEVER output unescaped data
function render_profile_UNSAFE($user) {
    echo '<h1>' . $user->name . '</h1>'; // XSS if name contains <script>
}
```

### Escaping Functions
| Function | Context |
|----------|---------|
| `esc_html()` | HTML body text |
| `esc_attr()` | HTML attributes |
| `esc_url()` | URLs in href/src |
| `esc_js()` | Inline JavaScript strings |
| `wp_json_encode()` | JSON data in scripts |

---

## 5. Prepared SQL Statements

**Prevents SQL injection.**

```php
<?php
// ALWAYS use prepared statements
function get_user_posts($user_id) {
    global $wpdb;

    $posts = $wpdb->get_results($wpdb->prepare(
        "SELECT * FROM {$wpdb->posts} WHERE post_author = %d AND post_status = %s",
        $user_id,
        'publish'
    ));

    return $posts;
}

// NEVER use string concatenation
function get_posts_UNSAFE($user_id) {
    global $wpdb;
    return $wpdb->get_results("SELECT * FROM {$wpdb->posts} WHERE post_author = $user_id");
}
```

### Prepared Statement Placeholders
| Placeholder | Type |
|-------------|------|
| `%d` | Integer |
| `%f` | Float |
| `%s` | String |

---

## Security Function Reference

### Quick Lookup Table

| Input Type | Sanitize | Escape (Output) |
|------------|----------|-----------------|
| Plain text | `sanitize_text_field()` | `esc_html()` |
| HTML content | `wp_kses_post()` | Already safe |
| Email | `sanitize_email()` | `esc_html()` |
| URL | `esc_url_raw()` | `esc_url()` |
| Integer | `absint()` | `absint()` |
| Filename | `sanitize_file_name()` | `esc_html()` |
| SQL | `$wpdb->prepare()` | N/A |
