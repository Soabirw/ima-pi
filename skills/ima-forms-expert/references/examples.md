# Complete Form Examples

## Contents

- [Understanding Validators-at-Registration](#understanding-validators-at-registration)
- [Contact Form with Validation Engine](#contact-form-with-validation-engine)
- [Form with Custom Cross-Field Validation](#form-with-custom-cross-field-validation)
- [Testing Patterns](#testing-patterns)
- [Anti-Patterns to Avoid](#anti-patterns-to-avoid)

---

## Understanding Validators-at-Registration

**Key v1.4.0 Architecture**: When you call `ima_forms_email_field()`, the field's `_register()` function builds validators as closures and stores them:

```php
// What happens inside ima_forms_email_field_register():
$validators = [];

if ($required) {
    // Validator closure captures $label via use()
    $validators[] = fn($v) => ima_forms_validate_required($v, $label);
}

// Email format validator (only runs if value provided)
$validators[] = function($v) use ($label, $enhanced) {
    if (empty($v)) return null;
    return ima_forms_validate_email_enhanced((string) $v, $label, $enhanced);
};

// Spec stores the closures directly
ima_forms_register_field_spec($name, [
    'type' => 'email',
    'validators' => $validators,  // Array of closures!
]);
```

**When validation runs** (inside `ima_forms_run_validators()`):
```php
foreach ($specs as $field_name => $spec) {
    $value = $sanitized[$field_name] ?? null;

    foreach ($spec['validators'] as $validator) {
        $error = $validator($value);  // Just call the closure!
        if ($error !== null) {
            $errors[$field_name] = $error;
            break;
        }
    }
}
```

**Benefits**:
- No type switching - validators are already built
- Single source of truth - field function defines validation once
- Testable - validators are pure functions

---

## Contact Form with Validation Engine

### Template File

```php
// Theme: templates/forms/contact-form.php
<?php
if (!defined('ABSPATH')) exit;

$errors = $args['errors'] ?? [];
$data = $args['data'] ?? [];
?>

<?php
ima_forms_form([
    'id' => 'contact-form',
    'action' => 'contact_form_submit',
], function() use ($data, $errors) {

    ima_forms_card(['title' => 'Contact Us'], function() use ($data, $errors) {

        ima_forms_text_field([
            'name' => 'name',
            'label' => 'Your Name',
            'required' => true,
            'value' => $data['name'] ?? '',
            'error' => $errors['name'] ?? '',
        ]);

        ima_forms_email_field([
            'name' => 'email',
            'label' => 'Email Address',
            'required' => true,
            'enhanced_validation' => true,
            'value' => $data['email'] ?? '',
            'error' => $errors['email'] ?? '',
        ]);

        ima_forms_textarea_field([
            'name' => 'message',
            'label' => 'Message',
            'required' => true,
            'rows' => 5,
            'maxlength' => 1000,
            'value' => $data['message'] ?? '',
            'error' => $errors['message'] ?? '',
        ]);

        ima_forms_submit_button([
            'text' => 'Send Message',
            'processing_text' => 'Sending...',
        ]);
    });
});
?>
```

### AJAX Handler

```php
// Theme: inc/forms/contact-form.php

function contact_form_ajax_handler() {
    // Nonce verification
    if (!wp_verify_nonce($_POST['nonce'], 'ima_forms_ajax')) {
        wp_send_json_error(['message' => 'Security check failed.'], 403);
    }

    // Validate using template
    $result = ima_forms_validate_form(
        'templates/forms/contact-form',
        $_POST,
        'contact-form'
    );

    if (!$result['valid']) {
        wp_send_json_error([
            'message' => 'Please correct the errors below.',
            'errors' => $result['errors']
        ], 400);
    }

    // Process validated data
    $data = $result['sanitized'];

    $sent = wp_mail(
        get_option('admin_email'),
        'New Contact Form Submission',
        "Name: {$data['name']}\nEmail: {$data['email']}\n\n{$data['message']}"
    );

    if (!$sent) {
        wp_send_json_error(['message' => 'Failed to send message.'], 500);
    }

    wp_send_json_success([
        'message' => 'Thank you! Your message has been sent.',
        'redirect' => home_url('/thank-you/')
    ]);
}

add_action('wp_ajax_contact_form_submit', 'contact_form_ajax_handler');
add_action('wp_ajax_nopriv_contact_form_submit', 'contact_form_ajax_handler');

// Shortcode
add_shortcode('contact_form', function() {
    ob_start();
    get_template_part('templates/forms/contact-form');
    return ob_get_clean();
});
```

## Form with Custom Cross-Field Validation

```php
// Add custom validation via filter
add_filter('ima_forms_validate_registration-form', function($errors, $sanitized, $specs) {
    // Cross-field validation: passwords must match
    if ($sanitized['password'] !== $sanitized['password_confirm']) {
        $errors['password_confirm'] = 'Passwords must match.';
    }

    // Business rule: age requirement
    if (!empty($sanitized['age']) && $sanitized['age'] < 18) {
        $errors['age'] = 'Must be 18 or older to register.';
    }

    // Conditional requirement
    if ($sanitized['specialty'] === 'Other' && empty($sanitized['specialty_other'])) {
        $errors['specialty_other'] = 'Please specify your specialty.';
    }

    return $errors;
}, 10, 3);
```

## Testing Patterns

### Unit Tests for Validators

```php
<?php
declare(strict_types=1);

use PHPUnit\Framework\TestCase;

class ValidatorTest extends TestCase {
    /**
     * @dataProvider emailProvider
     */
    public function test_validate_email_enhanced($email, $expected_valid, $expected_message) {
        $result = ima_forms_validate_email_enhanced($email, 'Email', true);

        if ($expected_valid) {
            $this->assertNull($result);
        } else {
            $this->assertIsString($result);
            if ($expected_message) {
                $this->assertStringContainsString($expected_message, $result);
            }
        }
    }

    public function emailProvider() {
        return [
            'valid email' => ['test@example.com', true, null],
            'disposable domain' => ['test@mailinator.com', false, 'not allowed'],
            'gmail typo' => ['test@gmial.com', false, 'gmail.com'],
            'invalid format' => ['not-an-email', false, 'valid'],
        ];
    }
}
```

### Testing Validation Engine

```php
public function test_validation_engine_with_template() {
    $_POST = [
        'name' => 'Test User',
        'email' => 'test@example.com',
        'message' => 'Test message',
    ];

    $result = ima_forms_validate_form(
        'templates/forms/contact-form',
        $_POST,
        'contact-form'
    );

    $this->assertTrue($result['valid']);
    $this->assertEmpty($result['errors']);
    $this->assertEquals('Test User', $result['sanitized']['name']);
}
```

## Anti-Patterns to Avoid

### ❌ Don't Skip Template-Driven Validation

```php
// ❌ WRONG - Manual field map creation
$field_map = [
    'name' => 'text',
    'email' => 'email',
    'phone' => 'phone',
];
$sanitized = ima_forms_sanitize_data($_POST, $field_map);
$validation = my_manual_validation($sanitized);

// ✅ CORRECT - Use Validation Engine
$result = ima_forms_validate_form('templates/forms/my-form', $_POST, 'my-form');
```

### ❌ Don't Duplicate Validation Logic

```php
// ❌ WRONG - Manual validators when field already registers specs
function my_form_validate($data) {
    $errors = [];
    if (empty($data['email'])) {
        $errors['email'] = 'Email is required.';
    }
    if (!filter_var($data['email'], FILTER_VALIDATE_EMAIL)) {
        $errors['email'] = 'Invalid email format.';
    }
    // ... more duplicated validation
}

// ✅ CORRECT - Let field registration handle it
$result = ima_forms_validate_form('templates/forms/my-form', $_POST, 'my-form');

// Add ONLY custom cross-field validation via filter
add_filter('ima_forms_validate_my-form', function($errors, $data) {
    if ($data['password'] !== $data['password_confirm']) {
        $errors['password_confirm'] = 'Passwords must match.';
    }
    return $errors;
}, 10, 2);
```

### ❌ Don't Forget Enhanced Validation

```php
// ❌ WRONG - Basic email validation for user-facing forms
ima_forms_email_field([
    'name' => 'email',
    'enhanced_validation' => false,  // Misses disposable domains!
]);

// ✅ CORRECT - Use enhanced validation (default)
ima_forms_email_field([
    'name' => 'email',
    'enhanced_validation' => true,  // Blocks spam domains, detects typos
]);
```

### ❌ Don't Use Old Factory Pattern for Simple Forms

```php
// ❌ WRONG - Unnecessary factory pattern complexity
['render' => $render, 'validate' => $validate] = ima_forms_create_form(...);

// ✅ CORRECT - Use Validation Engine for simpler approach
$result = ima_forms_validate_form('templates/forms/my-form', $_POST, 'my-form');
```

**Note**: Form factory pattern is still useful for programmatic field generation or complex dynamic validation composition.
