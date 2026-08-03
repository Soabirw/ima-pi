# Form Factory Pattern (v1.2.0) - Auto-Wired Validation

## Contents

- [Creating Forms with Auto-Validation](#creating-forms-with-auto-validation)
- [Auto-Wiring Field Functions](#auto-wiring-field-functions)
- [Extending with Custom Validation](#extending-with-custom-validation)
- [Form Wrapper Functions](#form-wrapper-functions)
- [Security Chokepoint Pattern](#security-chokepoint-pattern)

---

## Creating Forms with Auto-Validation

The form factory pattern uses function composition to automatically wire validators to field types:

```php
// Create form with auto-wired validation
['render' => $render, 'validate' => $validate] = ima_forms_create_form(
    'contact-form',  // Form ID
    function($register) use ($data, $errors) {
        // Use auto-wiring field functions
        ima_forms_email($register, [
            'name' => 'email',
            'label' => 'Email Address',
            'required' => true,
            'value' => $data['email'] ?? '',
            'error' => $errors['email'] ?? '',
        ]);

        ima_forms_phone($register, [
            'name' => 'phone',
            'label' => 'Phone Number',
            'required' => true,
            'value' => $data['phone'] ?? '',
            'error' => $errors['phone'] ?? '',
        ]);

        ima_forms_textarea($register, [
            'name' => 'message',
            'label' => 'Message',
            'required' => true,
            'value' => $data['message'] ?? '',
            'error' => $errors['message'] ?? '',
        ]);
    }
);

// Render form
$render();

// Validate (in AJAX handler)
$validation = $validate($sanitized_data);
if (!$validation['valid']) {
    wp_send_json_error(['errors' => $validation['errors']]);
}
```

## Auto-Wiring Field Functions

**Available auto-wiring functions** (automatically attach validators):

| Function | Validator |
|----------|-----------|
| `ima_forms_text($register, $args)` | Required validator |
| `ima_forms_email($register, $args)` | Format + enhanced validation |
| `ima_forms_phone($register, $args)` | Format validation |
| `ima_forms_url($register, $args)` | Format validation |
| `ima_forms_textarea($register, $args)` | Required validator |
| `ima_forms_select($register, $args)` | Required validator |
| `ima_forms_checkbox($register, $args)` | Required validator |
| `ima_forms_checkbox_group_field($register, $args)` | Required (array) |

## Extending with Custom Validation

```php
// Compose auto-wired + custom validators
$combined = ima_forms_compose_validators(
    $validate,  // Auto-wired from form factory
    function($data) {
        $errors = [];
        // Your custom validation
        if ($data['password'] !== $data['password_confirm']) {
            $errors['password_confirm'] = 'Passwords must match.';
        }
        return ['valid' => empty($errors), 'errors' => $errors];
    }
);
```

## Form Wrapper Functions

### Standardized Form Container

```php
ima_forms_form([
    'id' => 'my-form',
    'action' => 'my_ajax_action',  // AJAX action name
    'method' => 'post',
    'class' => 'ima-form w-100',   // Default: full width
    'nonce_action' => 'my_form_submit',
    'nonce_name' => 'nonce',
    'enqueue_base' => true,        // Auto-enqueue ima-forms-base.js
], function() {
    // Form fields here
    ima_forms_text_field([...]);
    ima_forms_email_field([...]);

    // Standardized submit button
    ima_forms_submit_button([
        'text' => 'Submit Form',
        'processing_text' => 'Submitting...',
        'class' => 'btn btn-primary',
        'show_spinner' => true,
    ]);
});
```

### Benefits

- **Automatic error container**: `.ima-form-errors` populated by JavaScript
- **Automatic success container**: `.ima-form-success` for success messages
- **AJAX-ready**: `data-action` attribute for JavaScript handler
- **Nonce included**: WordPress nonce field automatically added
- **Loading states**: Submit button shows spinner and disables during submission

## Security Chokepoint Pattern

### AJAX Handler Factory (Classic Approach)

```php
// Create secure AJAX handler
$handler = ima_forms_create_ajax_handler(
    'listing_application',           // Form ID
    'ima_form_listing_application',  // Nonce action
    'ima_listing_sanitize',          // Sanitization function
    'ima_listing_validate',          // Validation function
    'ima_listing_process'            // Processing function
);

// Register AJAX hooks
add_action('wp_ajax_ima_listing_submit', $handler);
add_action('wp_ajax_nopriv_ima_listing_submit', $handler);
```

**Security layers** (automatic):
1. **Nonce verification**: CSRF protection
2. **Sanitization**: Context-appropriate cleaning
3. **Validation**: Business rules enforcement
4. **Processing**: Controlled side effects

**Rate limiting**: Handled by infrastructure (WordFence, Akismet, WP Armour)

### Modern Approach with Validation Engine

```php
function my_form_ajax_handler() {
    // Security: Nonce verification
    if (!wp_verify_nonce($_POST['nonce'], 'my_form_submit')) {
        wp_send_json_error(['message' => 'Security check failed.'], 403);
    }

    // Validate + Sanitize (automatic via template)
    $result = ima_forms_validate_form(
        'templates/forms/my-form',
        $_POST,
        'my-form'
    );

    if (!$result['valid']) {
        wp_send_json_error([
            'message' => 'Please correct the errors.',
            'errors' => $result['errors']
        ], 400);
    }

    // Process validated data
    $data = $result['sanitized'];
    // ... your processing logic

    wp_send_json_success(['message' => 'Success!']);
}

add_action('wp_ajax_my_form_submit', 'my_form_ajax_handler');
```

### When to Use Which Pattern

| Pattern | Use When |
|---------|----------|
| **Validation Engine** (v1.3.0) | Simple forms, standard validation needs |
| **Form Factory** (v1.2.0) | Programmatic field generation, dynamic forms |
| **Classic AJAX Handler** | Legacy code, complex multi-step processing |
