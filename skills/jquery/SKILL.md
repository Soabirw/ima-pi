---
name: jquery
description: >-
  jQuery patterns and API reference for WordPress/Bootstrap environments where jQuery
  is already loaded. FP-aligned: chaining as composition, $.map/$.grep as declarative
  transforms, pure logic extraction. Use when: writing DOM manipulation in WordPress
  themes/plugins, working with Bootstrap JS components, handling events on dynamic
  content, AJAX in WordPress, any browser JS where jQuery is available. Triggers on:
  jQuery, $(), .on(), .find(), .ajax(), $.each, DOM manipulation in WordPress context,
  Bootstrap JS, "how do I select", "how do I toggle", event delegation, IIFE wrapper.
  IMPORTANT: In WordPress, jQuery IS native (0 additional bytes). Default to jQuery
  for DOM work unless building an isolated module with no WP plugin interaction.
---

# jQuery - FP-Aligned Patterns

**"jQuery IS native in WordPress. Reach for it first."**

Agents default to verbose vanilla JS even when jQuery is loaded. In WordPress, jQuery is always available (core dependency, 0 additional bytes). `$('.foo').on('click', ...)` beats `document.querySelectorAll('.foo').forEach(el => el.addEventListener('click', ...))`.

## Decision Tree

```
Writing browser JS in WordPress?
├── YES: Touches DOM (select, manipulate, events, AJAX)?
│   ├── YES → Use jQuery (default)
│   │   Exception: Pure business logic → vanilla JS in pure/ directory
│   └── NO (pure data transforms) → Vanilla JS
├── jQuery already loaded?
│   ├── YES → Use jQuery for DOM work
│   └── NO → Vanilla JS
└── No WordPress context → See js-fp
```

**Use jQuery:** WordPress theme/plugin JS, Bootstrap component interaction, Gravity Forms/ACF integration, `admin-ajax.php` AJAX, event delegation on dynamic content.

**Use vanilla JS:** Pure business logic, isolated ES module, Node.js, React/Vue internals.

## jQuery + FP: They're Compatible

### Chaining IS Composition

```javascript
$('.user-card')
    .filter('.active')
    .find('.username')
    .addClass('highlighted')
    .text(function(i, text) { return text.toUpperCase(); });
// No custom pipe() needed
```

### $.map / $.grep Are Declarative

```javascript
// Use for jQuery collections
var admins = $.grep(users, function(user) { return user.role === 'admin'; });

// Use native Array methods for plain arrays
var activeNames = users.filter(u => u.active).map(u => u.name);
```

### Pure Logic Extraction

```javascript
(function($) {
    'use strict';

    // PURE: Testable, no DOM
    function calculateShipping(weight, zone) {
        var rates = { domestic: 0.5, international: 1.2 };
        return Math.max(0, weight) * (rates[zone] || rates.domestic);
    }

    function formatPrice(amount) { return '$' + Math.max(0, amount).toFixed(2); }

    // IMPURE: DOM wrapper
    function ShippingCalculator($container) {
        this.$container = $container;
        this.$container.on('change', 'select, input', this.update.bind(this));
    }

    ShippingCalculator.prototype.update = function() {
        var weight = parseFloat(this.$container.find('[name="weight"]').val()) || 0;
        var zone = this.$container.find('[name="zone"]').val();
        this.$container.find('.shipping-cost').text(formatPrice(calculateShipping(weight, zone)));
    };

    $('.shipping-calculator').each(function() { new ShippingCalculator($(this)); });

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { calculateShipping, formatPrice };
    }
})(jQuery);
```

## Quick Reference

### IIFE Wrapper (WordPress Standard)

```javascript
(function($) {
    'use strict';
    // All jQuery code here, $ is safe
})(jQuery);

// Document ready shorthand
jQuery(function($) { /* DOM ready */ });
```

### Selectors and Traversal

```javascript
$('.class')                    // By class
$('#id')                       // By ID
$('[data-action="delete"]')    // By attribute
$('input[type="text"]')        // Attribute selector

$('.item')
    .closest('.container')     // Up: nearest ancestor
    .find('.target')           // Down: all descendants
    .siblings('.active')       // Sideways: siblings
    .parent()                  // Up: direct parent
    .children('.row')          // Down: direct children
    .first() / .last()
    .filter('.visible')
    .not('.disabled')
    .eq(2)                     // By index

var $form = $('#my-form');
$form.find('.field')           // Scoped selection (efficient)
```

### DOM Manipulation

```javascript
// Classes
$el.addClass('active') / $el.removeClass('loading') / $el.toggleClass('visible')
$el.hasClass('hidden')          // Returns boolean

// Content
$el.text('Plain text')          // Safe — escapes HTML
$el.html('<strong>HTML</strong>')
$el.val() / $el.val('new value')

// Attributes / Data
$el.attr('href') / $el.attr('href', '/new')
$el.prop('checked', true)       // For checkboxes, disabled, etc.
$el.data('user-id')             // Parsed, cached data-* value
$el.removeAttr('disabled')

// Insertion
$container.append($el) / $container.prepend($el)
$el.after($sibling) / $el.before($sibling)
$el.remove() / $el.empty() / $el.clone()

// CSS / Visibility
$el.css('color', 'red') / $el.css({ color: 'red', fontSize: '14px' })
$el.show() / $el.hide() / $el.toggle()
```

### Events

```javascript
$el.on('click', handler)                        // Direct
$container.on('click', '.child', handler)        // Delegated (dynamic content)
$el.off('click', handler) / $el.off('click')

// Namespaced (clean removal)
$el.on('click.myPlugin', handler)
$el.off('.myPlugin')

$el.one('click', handler)       // Fires once, auto-unbinds
```

### AJAX (WordPress)

```javascript
$.ajax({
    url: myVars.ajaxUrl,
    type: 'POST',
    data: { action: 'my_action', nonce: myVars.nonce, id: itemId },
    success: function(response) { if (response.success) { /* response.data */ } },
    error: function(xhr, status, error) { console.error('AJAX failed:', error); }
});

// Shorthand
$.get(myVars.restUrl + '/items', renderItems);
$.post(myVars.ajaxUrl, { action: 'save_item', data: formData }, handleResponse);

// Promise-style
$.ajax({ url: '/api/data', dataType: 'json' })
    .done(function(data) { })
    .fail(function(xhr) { })
    .always(function() { });
```

### Utilities

```javascript
$.each(array, function(index, value) { });
$.each(object, function(key, value) { });
$('.items').each(function(index) { var $this = $(this); });

// Prefer native — these jQuery equivalents are deprecated:
Array.isArray(val)              // not $.isArray
typeof val === 'string'         // not $.type

var merged = $.extend(true, {}, defaults, options);  // Deep merge
var data = $form.serialize();   // URL-encoded string
```

## Common Patterns

### Cache jQuery Selections

```javascript
// GOOD: Cache, then chain
var $el = $('.my-element');
$el.addClass('active').find('.child').show();

// BEST: Chain with .end()
$('.my-element')
    .addClass('active')
    .find('.child').show()
    .end()
    .data('loaded', true);
```

### Delegated Events for Dynamic Content

```javascript
// BAD: Won't fire on dynamically added elements
$('.delete-btn').on('click', handleDelete);

// GOOD: Fires for current AND future elements
$('.item-list').on('click', '.delete-btn', handleDelete);
```

### UI State Management

```javascript
(function($) {
    'use strict';

    function getToggleState($el) { return !$el.hasClass('is-open'); }

    function applyToggleState($trigger, $target, isOpen) {
        $trigger.attr('aria-expanded', isOpen);
        $target.toggleClass('is-open', isOpen);
        isOpen ? $target.slideDown(200) : $target.slideUp(200);
    }

    $('.accordion').on('click', '.accordion-trigger', function(e) {
        e.preventDefault();
        var $trigger = $(this);
        applyToggleState($trigger, $($trigger.data('target')), getToggleState($($trigger.data('target'))));
    });
})(jQuery);
```

## Anti-Patterns

| Anti-Pattern | Fix |
|---|---|
| Vanilla `querySelectorAll` + `forEach` in WP | `$('.selector').each()` |
| Mixing jQuery and vanilla in same file | Pick one per file |
| Not caching `$(this)` in loops | `var $this = $(this)` |
| `$('.selector')` inside loops | Cache outside loop |
| Direct binding on dynamic elements | Use delegated `.on()` |
| Custom `pipe()` / `compose()` | jQuery chaining IS composition |

## WordPress Coding Standards

- Tabs for indentation
- IIFE with `jQuery` passed as `$`
- `'use strict'` inside IIFE
- Spaces inside parens: `if ( condition )`
- `var` at top of scope (unless using ES6+ build tools)

## Integration

| Skill | Relationship |
|-------|-------------|
| `js-fp` | Core FP principles — pure logic extracted, side effects in DOM wrapper |
| `js-fp-wordpress` | WordPress-specific (GF hooks, ACF, admin JS) — references this skill |
| `ima-bootstrap` | Bootstrap 5 JS — jQuery available for custom enhancements |
| Context7 | Deep jQuery API lookups: library ID `/jquery/jquery` |
