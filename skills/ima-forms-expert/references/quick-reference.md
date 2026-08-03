# Quick Reference

## Contents

- [Field Components](#field-components-auto-registration)
- [Container Components](#container-components)
- [Validation Engine (v1.4.0)](#validation-engine-v140)
- [Registry Functions](#registry-functions)
- [Validators](#validators)
- [Sanitizers](#sanitizers)
- [Core Functions](#core-functions)
- [Version Features](#version-features)
- [Filters](#filters)

---

## Field Components (Auto-Registration)

| Function | Purpose |
|----------|---------|
| `ima_forms_text_field()` | Text input with validation |
| `ima_forms_email_field()` | Email with enhanced validation |
| `ima_forms_password_field()` | Password input |
| `ima_forms_hidden_field()` | Hidden field |
| `ima_forms_textarea_field()` | Multi-line text |
| `ima_forms_select_field()` | Dropdown select |
| `ima_forms_state_select_field()` | US states dropdown |
| `ima_forms_checkbox_field()` | Single checkbox |
| `ima_forms_checkbox_group()` | Multiple checkboxes |
| `ima_forms_phone_field()` | Phone with format validation |
| `ima_forms_url_field()` | URL with format validation |
| `ima_forms_address_fieldset()` | Composite address fields |
| `ima_forms_consent_agreement_field()` | Scrollable agreement + signature |

## Container Components

| Function | Purpose |
|----------|---------|
| `ima_forms_form()` | Complete form wrapper with AJAX |
| `ima_forms_submit_button()` | Standardized submit button |
| `ima_forms_card()` | Bootstrap card wrapper |
| `ima_forms_section()` | Section with heading |
| `ima_forms_column_layout()` | Responsive columns |
| `ima_forms_fieldset()` | Semantic fieldset |
| `ima_forms_repeater()` | Dynamic row repeater |

## Validation Engine (v1.4.0)

| Function | Purpose |
|----------|---------|
| `ima_forms_validate_form($template, $data, $form_id, $args)` | Main validation entry |
| `ima_forms_validate_against_specs($specs, $data)` | Validate data against specs |
| `ima_forms_run_validators($specs, $sanitized)` | Run stored validators |
| `ima_forms_sanitize_against_specs($specs, $data)` | Sanitize using specs |
| `ima_forms_debug_validation_summary($specs)` | Debug: validation preview |

## Registry Functions

| Function | Purpose |
|----------|---------|
| `ima_forms_register_field_spec($name, $spec)` | Register field spec + validators |
| `ima_forms_get_field_specs()` | Get all registered specs |
| `ima_forms_clear_field_specs()` | Clear registry |
| `ima_forms_has_field_spec($name)` | Check if field registered |
| `ima_forms_get_field_spec($name)` | Get single spec |
| `ima_forms_get_field_spec_count()` | Count registered specs |
| `ima_forms_debug_field_specs()` | Human-readable spec dump |

## Validators

| Function | Purpose |
|----------|---------|
| `ima_forms_validate_required($value, $label)` | Required check |
| `ima_forms_validate_email($email, $label)` | Basic RFC 5322 |
| `ima_forms_validate_email_enhanced($email, $label, $enhanced)` | Full email validation |
| `ima_forms_validate_phone($phone, $label)` | Phone format |
| `ima_forms_validate_url($url, $label)` | URL format |
| `ima_forms_validate_min_length($value, $min, $label)` | Min length |
| `ima_forms_validate_max_length($value, $max, $label)` | Max length |
| `ima_forms_validate_array_required($array, $label)` | Array not empty |
| `ima_forms_validate_numeric($value, $label)` | Numeric check |
| `ima_forms_validate_range($value, $min, $max, $label)` | Range check |
| `ima_forms_create_email_validator($domains, $typos)` | Pre-compiled validator |

## Sanitizers

| Function | Purpose |
|----------|---------|
| `ima_forms_sanitize_field($type, $value)` | Single field |
| `ima_forms_sanitize_data($data, $field_map)` | Multiple fields |
| `ima_forms_sanitize_repeater($rows, $field_map)` | Repeater rows |
| `ima_forms_sanitize_against_specs($specs, $data)` | Using specs (auto) |

## Core Functions

| Function | Purpose |
|----------|---------|
| `ima_forms_create_ajax_handler()` | Security chokepoint |
| `ima_forms_create_renderer()` | Template rendering |
| `ima_forms_load_field_template()` | Template hierarchy |
| `ima_forms_get_us_states()` | US states data |

## Version Features

### v1.4.0 (Validators at Registration)
- Validators built as closures at field registration
- `spec['validators']` stores closure array
- `ima_forms_run_validators()` just iterates and runs
- No type switching in engine

### v1.3.0 (Validation Engine)
- Template-driven validation
- Field spec registry
- Automatic sanitization from specs
- `ima_forms_validate_form()` as primary API

### v1.2.0 (Form Factory)
- Auto-wired validation via function composition
- `ima_forms_create_form()` factory
- `ima_forms_form()` and `ima_forms_submit_button()` wrappers
- Password and hidden field types
- Consent agreement component
- Enhanced email validation with disposable domains

### v1.1.0 (Container Components)
- Card, section, column layout, fieldset components
- Repeater with auto-enqueuing
- Template override system

### v1.0.0 (Foundation)
- Basic field components
- Pure validators and sanitizers
- Security chokepoint pattern
- Bootstrap 5 integration

## Filters

| Filter | Purpose |
|--------|---------|
| `ima_forms_validate_{form-id}` | Custom validation (cross-field, business rules) |
| `ima_forms_bad_email_domains` | Add blocked email domains |
| `ima_forms_email_typo_corrections` | Add typo corrections |

## Default Nonce

The default nonce action for `ima_forms_form()` is: `ima_forms_ajax`

```php
// In AJAX handler:
if (!wp_verify_nonce($_POST['nonce'], 'ima_forms_ajax')) {
    wp_send_json_error(['message' => 'Security check failed.'], 403);
}
```
