# Validation Engine - Validators-at-Registration Architecture

## Contents

- [Architecture Overview (v1.4.0)](#architecture-overview-v140)
- [How Field Registration Works](#how-field-registration-works)
- [Validation Flow](#validation-flow)
- [Field Spec Structure](#field-spec-structure)
- [Custom Validation via Filters](#custom-validation-via-filters)
- [Pure Validators](#pure-validators)
- [Enhanced Email Validator](#enhanced-email-validator)
- [Function Factory for Performance](#function-factory-for-performance)
- [Sanitization Patterns](#sanitization-patterns)
- [Debug Helpers](#debug-helpers)

---

## Architecture Overview (v1.4.0)

**Core concept**: Validators are built as closures at field registration time, not by the engine via type-switching.

### Old Architecture (v1.3.0)
```php
// Field registered spec with type metadata
ima_forms_register_field_spec('email', ['type' => 'email', 'required' => true, ...]);

// Engine rebuilt validators based on type switching
switch ($spec['type']) {
    case 'email':
        $error = ima_forms_validate_email_enhanced($value, ...);
        // etc.
}
```

### New Architecture (v1.4.0)
```php
// Field builds validators at registration time
$validators = [];
$validators[] = fn($v) => ima_forms_validate_required($v, $label);
$validators[] = fn($v) => empty($v) ? null : ima_forms_validate_email_enhanced($v, $label, true);

ima_forms_register_field_spec('email', [
    'type' => 'email',
    'validators' => $validators,  // Closures stored directly!
]);

// Engine simply iterates and runs
foreach ($spec['validators'] as $validator) {
    $error = $validator($value);
    if ($error !== null) break;
}
```

**Benefits**:
- **Single source of truth**: Field function defines validation once
- **No type switching**: Validators are closures, just iterate and run
- **Testable**: Validators are pure functions captured at registration time
- **Extensible**: Easy to add field-specific validators without touching engine

---

## How Field Registration Works

Each field function has a `_register()` function that builds validators:

```php
function ima_forms_text_field_register(array $args): void {
    $name = $args['name'] ?? '';
    $label = $args['label'] ?? $name;
    $required = $args['required'] ?? false;
    $minlength = $args['minlength'] ?? null;
    $maxlength = $args['maxlength'] ?? null;

    // Build validators at registration time
    $validators = [];

    if ($required) {
        $validators[] = fn($v) => ima_forms_validate_required($v, $label);
    }

    if ($minlength !== null) {
        $validators[] = function($v) use ($label, $minlength) {
            if (empty($v)) return null;
            return ima_forms_validate_min_length((string) $v, (int) $minlength, $label);
        };
    }

    if ($maxlength !== null) {
        $validators[] = function($v) use ($label, $maxlength) {
            if (empty($v)) return null;
            return ima_forms_validate_max_length((string) $v, (int) $maxlength, $label);
        };
    }

    ima_forms_register_field_spec($name, [
        'type' => 'text',
        'label' => $label,
        'required' => $required,
        'validators' => $validators,
        'sanitize_type' => 'text',
    ]);
}
```

**Key insight**: The `$validators` array contains closures that capture the field's label and constraints via `use`. When the engine runs them, it just calls each closure with the value.

---

## Validation Flow

```php
// 1. Include template → field functions register specs + validators
ima_forms_validate_form('templates/forms/my-form', $_POST, 'my-form');

// Inside ima_forms_validate_form():
// a) Clear registry (clean state)
ima_forms_clear_field_specs();

// b) Include template (fields register their specs + validators)
ob_start();
get_template_part($template_path, null, $template_args);
ob_end_clean();

// c) Get collected specs (with validators already built)
$specs = ima_forms_get_field_specs();

// d) Sanitize data based on specs
$sanitized = ima_forms_sanitize_against_specs($specs, $data);

// e) Run validators (simple iteration!)
$errors = ima_forms_run_validators($specs, $sanitized);

// f) Run custom validation filter
$errors = apply_filters("ima_forms_validate_{$form_id}", $errors, $sanitized, $specs);

// g) Return result
return ['valid' => empty($errors), 'errors' => $errors, 'sanitized' => $sanitized];
```

---

## Field Spec Structure

```php
[
    'type' => 'email',                    // Field type (for sanitization fallback)
    'label' => 'Email Address',           // For error messages
    'required' => true,                   // Whether field is required
    'enhanced_validation' => true,        // Email-specific: domain checking
    'sanitize_type' => 'email',           // Sanitization type
    'validators' => [                     // Array of closures!
        fn($v) => ima_forms_validate_required($v, 'Email Address'),
        fn($v) => empty($v) ? null : ima_forms_validate_email_enhanced($v, 'Email Address', true),
    ],
]
```

---

## Custom Validation via Filters

```php
// Add custom validation logic (runs after field validators)
add_filter('ima_forms_validate_my-form', function($errors, $sanitized, $specs) {
    // Cross-field validation
    if ($sanitized['password'] !== $sanitized['password_confirm']) {
        $errors['password_confirm'] = 'Passwords must match.';
    }

    // Business rules
    if (!empty($sanitized['age']) && $sanitized['age'] < 18) {
        $errors['age'] = 'Must be 18 or older.';
    }

    return $errors;
}, 10, 3);
```

---

## Pure Validators

All validators return `null` for valid, error string for invalid:

```php
function ima_forms_validate_required($value, string $label): ?string {
    if (empty($value) && $value !== '0') {
        return "{$label} is required.";
    }
    return null;
}
```

**Available validators**:
- `ima_forms_validate_required($value, $label)`
- `ima_forms_validate_email($email, $label)` - Basic RFC 5322
- `ima_forms_validate_email_enhanced($email, $label, $enhanced)` - With domain/typo checking
- `ima_forms_validate_url($url, $label)`
- `ima_forms_validate_phone($phone, $label)` - 10-15 digits, allows formatting
- `ima_forms_validate_min_length($value, $min, $label)`
- `ima_forms_validate_max_length($value, $max, $label)`
- `ima_forms_validate_array_required($array, $label)`
- `ima_forms_validate_numeric($value, $label)`
- `ima_forms_validate_range($value, $min, $max, $label)`

---

## Enhanced Email Validator

```php
$error = ima_forms_validate_email_enhanced(
    'user@gmial.com',  // Input
    'Email Address',    // Label for error message
    true               // Enable enhanced checks
);
// Returns: "Did you mean user@gmail.com? Please check your email address."
```

**Features**:
- RFC 5322 format validation
- Disposable domain blocking (20+ domains: mailinator, tempmail, etc.)
- Common typo detection (gmial.com → gmail.com)

**Customize blocked domains**:
```php
add_filter('ima_forms_bad_email_domains', function($domains) {
    $domains[] = 'example-spam.com';
    return $domains;
});
```

**Customize typo corrections**:
```php
add_filter('ima_forms_email_typo_corrections', function($corrections) {
    $corrections['customemail.co'] = 'customemail.com';
    return $corrections;
});
```

---

## Function Factory for Performance

**Pre-compile email validator** for repeated validations (2-5x faster in bulk operations):

```php
// Create validator once with configuration
$validator = ima_forms_create_email_validator(
    ['spam.com', 'tempmail.com'],  // Bad domains
    ['gmial.com' => 'gmail.com']   // Typo corrections
);

// Use for multiple emails (hot path optimization)
foreach ($emails as $email) {
    $error = $validator($email, 'Email');
}
```

---

## Sanitization Patterns

### Automatic Sanitization

When using the Validation Engine, sanitization is automatic:

```php
$result = ima_forms_validate_form(...);
// $result['sanitized'] contains sanitized data
```

### Sanitization Type Mapping

```php
function ima_forms_get_sanitize_type_for_field(array $spec): string {
    return match ($spec['type']) {
        'email' => 'email',
        'url' => 'url',
        'textarea' => 'textarea',
        'checkbox' => 'boolean',
        'checkbox_group' => 'checkbox_array',
        'phone' => 'phone',
        default => 'text',
    };
}
```

### Repeater Sanitization

```php
$sanitized_locations = ima_forms_sanitize_repeater(
    $_POST['additional_locations'] ?? [],
    ['location_name' => 'text', 'contact_email' => 'email']
);
```

---

## Debug Helpers

### See Registered Specs

```php
echo ima_forms_debug_field_specs();
// Output:
// Registered Field Specs (4):
//   - name: text [REQUIRED]
//   - email: email [REQUIRED]
//   - phone: phone
//   - message: textarea [REQUIRED]
```

### See Validation Summary

```php
$specs = ima_forms_get_field_specs();
echo ima_forms_debug_validation_summary($specs);
// Output:
// Validation Summary (4 fields):
//   name (text, REQUIRED): [2 validator(s)]
//   email (email, REQUIRED): [2 validator(s)]
//   phone (phone, optional): [1 validator(s)]
//   message (textarea, REQUIRED): [1 validator(s)]
```

### Registry Functions

| Function | Purpose |
|----------|---------|
| `ima_forms_register_field_spec($name, $spec)` | Register a field spec |
| `ima_forms_get_field_specs()` | Get all registered specs |
| `ima_forms_clear_field_specs()` | Clear registry (used by engine) |
| `ima_forms_has_field_spec($name)` | Check if field registered |
| `ima_forms_get_field_spec($name)` | Get single spec |
| `ima_forms_get_field_spec_count()` | Count registered specs |
| `ima_forms_debug_field_specs()` | Human-readable spec dump |
