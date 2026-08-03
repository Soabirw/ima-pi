# WordPress Hooks Integration

Patterns for integrating with WordPress plugins and admin.

## Table of Contents

1. [Gravity Forms Integration](#gravity-forms-integration)
2. [ACF Integration](#acf-integration)
3. [WordPress Admin Integration](#wordpress-admin-integration)
4. [Pure Business Logic Pattern](#pure-business-logic-pattern)
5. [Testing Strategy](#testing-strategy)

---

## Gravity Forms Integration

**MUST use jQuery** - GF events are jQuery-based:

```javascript
(function($) {
    'use strict';

    // Form render event
    $(document).on('gform_post_render', function(event, formId) {
        var $form = $('#gform_' + formId);

        // Initialize custom fields
        initConsentFields($form);
        initRepeaterFields($form);
    });

    // Form confirmation event
    $(document).on('gform_confirmation_loaded', function(event, formId) {
        // Track form completion
        if (typeof gtag === 'function') {
            gtag('event', 'form_submit', {
                'form_id': formId
            });
        }
    });

})(jQuery);
```

---

## ACF Integration

ACF uses jQuery events:

```javascript
(function($) {
    'use strict';

    if (typeof acf !== 'undefined') {
        // ACF fields are ready
        acf.addAction('ready', function($el) {
            initAcfEnhancements($el);
        });

        // New ACF repeater row added
        acf.addAction('append', function($el) {
            initAcfEnhancements($el);
        });
    }

    // ACF field interaction - matches ecosystem
    acf.addAction('ready', function() {
        $('.acf-field-type-repeater').each(function() {
            setupRepeaterEnhancements($(this));
        });
    });

})(jQuery);
```

---

## WordPress Admin Integration

```javascript
(function($) {
    'use strict';

    $(document).ready(function() {
        // Admin-specific enhancements
        if (typeof pagenow !== 'undefined' && pagenow === 'edit-listing') {
            initListingAdminEnhancements();
        }
    });

})(jQuery);
```

---

## Pure Business Logic Pattern

**Rule**: Extract pure JavaScript functions from DOM-dependent code.

### Bad: Mixed Business Logic and DOM

```javascript
(function($) {
    $('.price-calculator').on('change', 'input', function() {
        var quantity = parseInt($('#quantity').val()) || 0;
        var price = parseFloat($('#unit-price').val()) || 0;
        var discount = parseFloat($('#discount').val()) || 0;

        // Business logic mixed with DOM operations
        var subtotal = quantity * price;
        var discountAmount = subtotal * (discount / 100);
        var total = subtotal - discountAmount;

        $('#subtotal').text('$' + subtotal.toFixed(2));
        $('#discount-amount').text('-$' + discountAmount.toFixed(2));
        $('#total').text('$' + total.toFixed(2));
    });
})(jQuery);
```

### Good: Separated Pure Logic + DOM Wrapper

```javascript
(function($) {
    'use strict';

    // ===== Pure business logic (testable without DOM) =====
    function calculatePricing(quantity, unitPrice, discountPercent) {
        var subtotal = Math.max(0, quantity) * Math.max(0, unitPrice);
        var discountAmount = subtotal * (Math.min(100, Math.max(0, discountPercent)) / 100);
        var total = subtotal - discountAmount;

        return {
            subtotal: subtotal,
            discountAmount: discountAmount,
            total: total
        };
    }

    function formatCurrency(amount) {
        return '$' + amount.toFixed(2);
    }

    // ===== DOM wrapper (side effects isolated here) =====
    function PriceCalculator($container) {
        this.$container = $container;
        this.$quantity = $container.find('#quantity');
        this.$unitPrice = $container.find('#unit-price');
        this.$discount = $container.find('#discount');
        this.$subtotal = $container.find('#subtotal');
        this.$discountAmount = $container.find('#discount-amount');
        this.$total = $container.find('#total');

        this.init();
    }

    PriceCalculator.prototype.init = function() {
        this.$container.on('change', 'input', this.update.bind(this));
    };

    PriceCalculator.prototype.getInputValues = function() {
        return {
            quantity: parseInt(this.$quantity.val()) || 0,
            unitPrice: parseFloat(this.$unitPrice.val()) || 0,
            discount: parseFloat(this.$discount.val()) || 0
        };
    };

    PriceCalculator.prototype.update = function() {
        var values = this.getInputValues();
        var pricing = calculatePricing(values.quantity, values.unitPrice, values.discount);

        this.$subtotal.text(formatCurrency(pricing.subtotal));
        this.$discountAmount.text('-' + formatCurrency(pricing.discountAmount));
        this.$total.text(formatCurrency(pricing.total));
    };

    // ===== Initialization =====
    $('.price-calculator').each(function() {
        new PriceCalculator($(this));
    });

    // ===== Export for testing (optional) =====
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { calculatePricing: calculatePricing, formatCurrency: formatCurrency };
    }

})(jQuery);
```

---

## Testing Strategy

### Pure Functions (Jest/Node)

```javascript
// pure/calculations.js
function calculatePricing(quantity, unitPrice, discountPercent) {
    var subtotal = Math.max(0, quantity) * Math.max(0, unitPrice);
    var discountAmount = subtotal * (Math.min(100, Math.max(0, discountPercent)) / 100);
    var total = subtotal - discountAmount;

    return { subtotal: subtotal, discountAmount: discountAmount, total: total };
}

module.exports = { calculatePricing: calculatePricing };

// pure/calculations.test.js
var calculatePricing = require('./calculations').calculatePricing;

describe('calculatePricing', function() {
    it('calculates correct pricing', function() {
        var result = calculatePricing(10, 25, 10);
        expect(result.subtotal).toBe(250);
        expect(result.discountAmount).toBe(25);
        expect(result.total).toBe(225);
    });

    it('handles zero quantity', function() {
        var result = calculatePricing(0, 25, 10);
        expect(result.total).toBe(0);
    });

    it('handles negative values gracefully', function() {
        var result = calculatePricing(-5, 25, 10);
        expect(result.total).toBe(0);
    });
});
```

---

## File Organization

```
plugin-name/
└── assets/
    └── js/
        ├── plugin-base.js         # jQuery - AJAX, GF integration
        ├── plugin-admin.js        # jQuery - Admin UI interactions
        ├── plugin-repeater.js     # Vanilla - Isolated component
        ├── plugin-validation.js   # Vanilla - Pure validation logic
        └── pure/
            ├── formatting.js      # Pure functions (testable)
            └── calculations.js    # Pure functions (testable)
```
