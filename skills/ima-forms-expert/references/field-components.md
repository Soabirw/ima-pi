# Field Components Reference

## Contents

- [Text Input Field](#text-input-field)
- [Email Field](#email-field)
- [Password Field](#password-field)
- [Hidden Field](#hidden-field)
- [Textarea Field](#textarea-field)
- [Select Field](#select-field)
- [Checkbox Field](#checkbox-field)
- [Checkbox Group](#checkbox-group)
- [Phone Field](#phone-field)
- [URL Field](#url-field)
- [Address Fieldset](#address-fieldset)
- [Consent Agreement Field](#consent-agreement-field)
- [Repeater (Dynamic Rows)](#repeater-dynamic-rows)

---

All field components auto-register validation specs when rendered. Use `required => true` to enable required validation.

## Text Input Field

```php
ima_forms_text_field([
    'name' => 'field_name',
    'label' => 'Field Label',
    'value' => $data['field_name'] ?? '',
    'required' => true,
    'placeholder' => 'Enter value...',
    'maxlength' => 100,
    'minlength' => 3,
    'pattern' => '[A-Za-z]+',       // HTML5 pattern
    'wrapper_class' => 'mb-3',
    'input_class' => 'form-control',
    'help_text' => 'Additional guidance',
    'error' => $errors['field_name'] ?? '',
]);

// Auto-registers: type, required, minlength, maxlength validation
```

## Email Field

```php
ima_forms_email_field([
    'name' => 'email',
    'label' => 'Email Address',
    'value' => $data['email'] ?? '',
    'required' => true,
    'placeholder' => 'user@example.com',
    'enhanced_validation' => true,  // Disposable domains + typo detection
    'wrapper_class' => 'mb-3',
    'help_text' => 'We will never share your email',
    'error' => $errors['email'] ?? '',
]);
```

**Enhanced validation includes**:
- RFC 5322 format validation
- Disposable domain blocking (mailinator, tempmail, etc.)
- Common typo detection (gmial.com → gmail.com)

## Password Field

```php
ima_forms_password_field([
    'name' => 'password',
    'label' => 'Password',
    'required' => true,
    'minlength' => 8,
    'placeholder' => 'Enter password',
    'wrapper_class' => 'mb-3',
    'help_text' => 'Minimum 8 characters',
    'error' => $errors['password'] ?? '',
    'attributes' => [
        'autocomplete' => 'new-password',
    ],
]);
```

## Hidden Field

```php
ima_forms_hidden_field([
    'name' => 'form_id',
    'value' => 'contact-form',
    'label' => 'Form ID',  // For debugging only
]);
```

## Textarea Field

```php
ima_forms_textarea_field([
    'name' => 'message',
    'label' => 'Message',
    'value' => $data['message'] ?? '',
    'required' => true,
    'rows' => 5,
    'maxlength' => 1000,
    'placeholder' => 'Enter your message...',
    'wrapper_class' => 'mb-3',
    'error' => $errors['message'] ?? '',
]);
```

## Select Field

```php
ima_forms_select_field([
    'name' => 'category',
    'label' => 'Category',
    'value' => $data['category'] ?? '',
    'required' => true,
    'options' => [
        '' => 'Select a category...',
        'general' => 'General Inquiry',
        'support' => 'Technical Support',
        'sales' => 'Sales Question',
    ],
    'wrapper_class' => 'mb-3',
    'error' => $errors['category'] ?? '',
]);
```

### State Select (Pre-populated)

```php
ima_forms_state_select_field([
    'name' => 'state',
    'label' => 'State',
    'value' => $data['state'] ?? '',
    'required' => true,
    'wrapper_class' => 'mb-3',
    'error' => $errors['state'] ?? '',
]);

// Uses ima_forms_get_us_states() for options
```

## Checkbox Field

```php
ima_forms_checkbox_field([
    'name' => 'subscribe',
    'label' => 'Subscribe to newsletter',
    'checked' => !empty($data['subscribe']),
    'required' => false,
    'wrapper_class' => 'mb-3',
    'error' => $errors['subscribe'] ?? '',
]);
```

## Checkbox Group

```php
ima_forms_checkbox_group([
    'name' => 'interests',
    'label' => 'Areas of Interest',
    'values' => $data['interests'] ?? [],
    'required' => true,
    'options' => [
        'web' => 'Web Development',
        'mobile' => 'Mobile Apps',
        'design' => 'UI/UX Design',
        'marketing' => 'Digital Marketing',
    ],
    'wrapper_class' => 'mb-3',
    'errors' => $errors['interests'] ?? '',
]);
```

## Phone Field

```php
ima_forms_phone_field([
    'name' => 'phone',
    'label' => 'Phone Number',
    'value' => $data['phone'] ?? '',
    'required' => true,
    'placeholder' => '(555) 123-4567',
    'wrapper_class' => 'mb-3',
    'error' => $errors['phone'] ?? '',
]);

// Validates: 10-15 digits, allows common formatting
```

## URL Field

```php
ima_forms_url_field([
    'name' => 'website',
    'label' => 'Website URL',
    'value' => $data['website'] ?? '',
    'required' => false,
    'placeholder' => 'https://example.com',
    'wrapper_class' => 'mb-3',
    'error' => $errors['website'] ?? '',
]);
```

## Address Fieldset

Composite field that registers multiple validation specs:

```php
ima_forms_address_fieldset([
    'name_prefix' => 'billing',  // Creates: billing_street, billing_city, etc.
    'label' => 'Billing Address',
    'values' => [
        'street' => $data['billing_street'] ?? '',
        'line2' => $data['billing_line2'] ?? '',
        'city' => $data['billing_city'] ?? '',
        'state' => $data['billing_state'] ?? '',
        'zip' => $data['billing_zip'] ?? '',
        'country' => $data['billing_country'] ?? 'United States',
    ],
    'required' => true,
    'wrapper_class' => 'mb-3',
    'errors' => $errors,  // Pass all errors, fieldset extracts relevant ones
]);

// Registers 4 specs: {prefix}_street, {prefix}_city, {prefix}_state, {prefix}_zip
```

## Consent Agreement Field

Complex component with scrollable content, checkbox, and signature:

```php
// Load agreement content
ob_start();
include get_template_directory() . '/templates/agreements/terms-of-service.php';
$agreement_html = ob_get_clean();

ima_forms_consent_agreement_field([
    'content_html' => $agreement_html,
    'checkbox_name' => 'agree_to_terms',
    'checkbox_label' => 'I have read and agree to the terms',
    'signature_name' => 'signature',
    'signature_label' => 'Type your full name as signature',
    'scroll_height' => '350px',
    'required' => true,
    'wrapper_class' => 'mb-4',
    'errors' => [
        'agree_to_terms' => $errors['agree_to_terms'] ?? '',
        'signature' => $errors['signature'] ?? '',
    ],
    'checkbox_value' => $_POST['agree_to_terms'] ?? null,
    'signature_value' => $_POST['signature'] ?? '',
]);
```

**Features**:
- Checkbox disabled until user scrolls to bottom
- Signature field disabled until checkbox checked
- Auto-enqueues `ima-forms-consent.js`
- Registers TWO validation specs (checkbox + signature)

## Repeater (Dynamic Rows)

```php
ima_forms_repeater([
    'name' => 'additional_locations',
    'label' => 'Additional Locations',
    'description' => 'Add multiple practice locations',
    'min_rows' => 0,
    'max_rows' => 10,
    'add_button_text' => 'Add Location',
    'values' => $data['additional_locations'] ?? [],
    'errors' => $errors['additional_locations'] ?? [],
], function($index, $row_data, $row_errors) {
    // Row template - use array bracket notation
    ima_forms_text_field([
        'name' => "additional_locations[{$index}][location_name]",
        'label' => 'Location Name',
        'value' => $row_data['location_name'] ?? '',
        'error' => $row_errors['location_name'] ?? '',
        'wrapper_class' => 'mb-3',
    ]);

    ima_forms_text_field([
        'name' => "additional_locations[{$index}][address]",
        'label' => 'Address',
        'value' => $row_data['address'] ?? '',
        'error' => $row_errors['address'] ?? '',
        'wrapper_class' => 'mb-3',
    ]);
});
```

**Features**:
- Auto-enqueues `ima-forms-repeater.js`
- Template placeholder uses `__INDEX__` (skipped during validation)
- Vanilla JavaScript (no jQuery dependency)
