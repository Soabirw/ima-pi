# Container Components Reference

## Contents

- [Form Wrapper](#form-wrapper)
- [Submit Button](#submit-button)
- [Card Wrapper](#card-wrapper)
- [Section with Heading](#section-with-heading)
- [Column Layout](#column-layout)
- [Fieldset](#fieldset)

---

## Form Wrapper

Complete form container with AJAX support:

```php
ima_forms_form([
    'id' => 'my-form',
    'action' => 'my_ajax_action',      // AJAX action name
    'method' => 'post',
    'class' => 'ima-form w-100',       // Default: full width
    'nonce_action' => 'my_form_submit',
    'nonce_name' => 'nonce',
    'enqueue_base' => true,            // Auto-enqueue ima-forms-base.js
], function() {
    // Form fields here
});
```

**Auto-generated elements**:
- `.ima-form-errors` - Error container (populated by JS)
- `.ima-form-success` - Success container
- Nonce field
- `data-action` attribute for JS handler

## Submit Button

```php
ima_forms_submit_button([
    'text' => 'Submit Form',
    'processing_text' => 'Submitting...',
    'class' => 'btn btn-primary',
    'show_spinner' => true,
    'disabled' => false,
    'wrapper_class' => 'mt-4',
]);
```

**Features**:
- Shows spinner during submission
- Disables button during processing
- Text changes to `processing_text` when submitting

## Card Wrapper

Bootstrap card with optional header:

```php
ima_forms_card([
    'title' => 'Personal Information',
    'description' => 'Please provide your contact details',
    'card_class' => 'shadow-sm',
    'wrapper_class' => 'mb-4',
    'show_header' => true,
], function() use ($data, $errors) {
    ima_forms_text_field([...]);
    ima_forms_email_field([...]);
});
```

## Section with Heading

Semantic section with heading and optional separator:

```php
ima_forms_section([
    'heading' => 'Contact Information',
    'description' => 'How can we reach you?',
    'heading_tag' => 'h3',
    'heading_class' => 'mb-3',
    'show_separator' => true,
    'wrapper_class' => 'mb-4',
], function() use ($data, $errors) {
    // Fields here
});
```

## Column Layout

Responsive multi-column layout:

```php
ima_forms_column_layout([
    'columns' => 3,           // 1-6 columns
    'breakpoint' => 'md',     // Collapse below: sm, md, lg, xl, xxl
    'gap' => 3,               // Bootstrap gap (0-5)
    'wrapper_class' => 'mb-3',
], function() use ($data, $errors) {
    // Fields render side-by-side (desktop) or stacked (mobile)
    ima_forms_text_field([
        'name' => 'city',
        'label' => 'City',
        'wrapper_class' => 'mb-0',  // Remove bottom margin in columns
        ...
    ]);
    ima_forms_state_select_field([
        'name' => 'state',
        'wrapper_class' => 'mb-0',
        ...
    ]);
    ima_forms_text_field([
        'name' => 'zip',
        'label' => 'ZIP',
        'wrapper_class' => 'mb-0',
        ...
    ]);
});
```

**Breakpoint behavior**:
| Breakpoint | Stacks below |
|------------|--------------|
| `sm` | 576px |
| `md` | 768px |
| `lg` | 992px |
| `xl` | 1200px |
| `xxl` | 1400px |

## Fieldset

Semantic grouping with legend:

```php
ima_forms_fieldset([
    'legend' => 'Shipping Address',
    'description' => 'Where should we ship your order?',
    'fieldset_class' => 'mb-4',
    'disabled' => false,
], function() use ($data, $errors) {
    // Address fields
});
```

**Use fieldset when**:
- Grouping related fields semantically
- Need to disable a group of fields together
- Accessibility requirements (screen readers)

**Use card when**:
- Visual grouping with styling
- Collapsible sections
- Decorative separation
