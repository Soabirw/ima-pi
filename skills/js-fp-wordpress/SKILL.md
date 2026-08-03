---
name: "js-fp-wordpress"
description: "FP patterns for JavaScript in WordPress/Bootstrap context - ecosystem-native patterns, jQuery guidance, pure business logic"
---

# JavaScript FP - WordPress/Bootstrap

**"In WordPress, jQuery IS native. Use what's simple and matches the ecosystem."**

jQuery is always available (WordPress core dependency, 0 additional bytes). The js-fp "Native patterns > FP utilities" rule targets custom `pipe()`/`curry()` abstractions — not established ecosystem libraries like jQuery. Builds on `../js-fp/SKILL.md`.

## Decision Matrix

| Context | Recommendation |
|---------|---------------|
| New isolated component | Vanilla JS |
| AJAX operations | jQuery `$.ajax` |
| Integrating with WP plugins | jQuery |
| Animation | CSS transitions |
| Pure business logic | Vanilla JS (no DOM, fully testable) |
| DOM event delegation | Either |

## jQuery Is Already Loaded — Arguments That Don't Apply

| Argument | Why It Fails Here |
|----------|------------------|
| "jQuery adds bundle size" | Already loaded — 0 additional bytes |
| "jQuery is a dependency" | Already a core WordPress dependency |
| "jQuery is slower" | Negligible for DOM operations |

## Practical Guidelines

### Don't Rewrite Working jQuery

YAGNI applies. Working jQuery code stays:

```javascript
(function($) {
    'use strict';

    $('.ima-form').on('submit', function(e) {
        e.preventDefault();
        $.ajax({
            url: imaAjax.url,
            type: 'POST',
            data: $(this).serialize(),
            success: function(response) {
                $(this).find('.ima-response').html(response.message);
            }
        });
    });

})(jQuery);
```

### Choose Based on Context

```javascript
// jQuery: WordPress plugin integration (must use jQuery for GF events)
(function($) {
    'use strict';
    $(document).on('gform_post_render', function(event, formId) {
        initImaFields($('#gform_' + formId));
    });
})(jQuery);

// Vanilla JS: Isolated component, no WP plugin interaction
(function() {
    'use strict';
    document.querySelectorAll('[data-repeater-container]').forEach(function(el) {
        new RepeaterController(el);
    });
})();
```

### Consistent Within Files

Pick one approach per file. No mixing jQuery and vanilla selectors in the same scope.

## Pure Business Logic Pattern

Extract pure functions from DOM-dependent code.

```javascript
(function($) {
    'use strict';

    // PURE: Testable without DOM
    function calculatePricing(quantity, unitPrice, discountPercent) {
        var subtotal = Math.max(0, quantity) * Math.max(0, unitPrice);
        var discount = subtotal * (Math.min(100, Math.max(0, discountPercent)) / 100);
        return { subtotal, discountAmount: discount, total: subtotal - discount };
    }

    function formatCurrency(amount) { return '$' + amount.toFixed(2); }

    // IMPURE: DOM wrapper — side effects isolated here
    function PriceCalculator($container) {
        this.$container = $container;
        this.$container.on('change', 'input', this.update.bind(this));
    }

    PriceCalculator.prototype.update = function() {
        var values = {
            quantity: parseInt(this.$container.find('#quantity').val()) || 0,
            unitPrice: parseFloat(this.$container.find('#unit-price').val()) || 0,
            discount: parseFloat(this.$container.find('#discount').val()) || 0
        };
        this.$container.find('#total').text(formatCurrency(
            calculatePricing(values.quantity, values.unitPrice, values.discount).total
        ));
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { calculatePricing, formatCurrency };
    }

})(jQuery);
```

## Anti-Patterns

- Rewriting working jQuery to vanilla for no benefit
- Using `document.addEventListener('gform_post_render', ...)` — GF fires on jQuery only
- Custom `pipe`/`compose` utilities — use direct function calls instead

## File Organization

```
plugin-name/assets/js/
├── plugin-base.js         # jQuery — AJAX, GF integration
├── plugin-admin.js        # jQuery — Admin UI
├── plugin-repeater.js     # Vanilla — Isolated component
└── pure/
    ├── formatting.js      # Pure functions (testable)
    └── calculations.js    # Pure functions (testable)
```

## Quality Gates

1. Needs jQuery-plugin interaction (GF, ACF)? → Use jQuery
2. Existing working code? → Enhance, don't rewrite
3. Business logic separated from DOM operations?
4. File uses one approach consistently?
5. Pure functions testable without DOM?
6. Adding complexity without clear benefit? → YAGNI

## Reference Files

| File | Load When |
|------|-----------|
| `references/ajax-patterns.md` | jQuery $.ajax, vanilla fetch, error handling, retry |
| `references/event-patterns.md` | Event delegation, DOMContentLoaded, document ready |
| `references/wp-integration.md` | GF hooks, ACF hooks, admin JS, pure logic extraction |
| `../php-fp-wordpress/SKILL.md` | Server-side: AJAX handlers, security, PHP/JS coordination |
| `../js-fp/SKILL.md` | Core FP: purity, composition, DI, testing |
