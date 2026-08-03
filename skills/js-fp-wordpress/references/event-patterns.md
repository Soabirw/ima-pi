# Event Delegation Patterns

Event handling patterns for WordPress JavaScript.

## Table of Contents

1. [jQuery Event Delegation](#jquery-event-delegation)
2. [Vanilla Event Delegation](#vanilla-event-delegation)
3. [DOMContentLoaded Patterns](#domcontentloaded-patterns)

---

## jQuery Event Delegation

### Document-Level Delegation

For dynamically added elements:

```javascript
(function($) {
    'use strict';

    // Delegated events - works with dynamically added elements
    $(document).on('click', '.ima-toggle-btn', function(e) {
        e.preventDefault();
        var $target = $($(this).data('target'));
        $target.toggleClass('is-visible');
    });

})(jQuery);
```

### Scoped Delegation (More Efficient)

```javascript
(function($) {
    'use strict';

    // Scoped delegation - better performance
    $('.ima-component').on('click', '.ima-action-btn', function(e) {
        e.preventDefault();
        handleAction($(this).data('action'), $(this).closest('.ima-item'));
    });

})(jQuery);
```

---

## Vanilla Event Delegation

### Document-Level Pattern

```javascript
(function() {
    'use strict';

    // Delegated events using event bubbling
    document.addEventListener('click', function(e) {
        // Toggle button delegation
        if (e.target.matches('.ima-toggle-btn') || e.target.closest('.ima-toggle-btn')) {
            e.preventDefault();
            var btn = e.target.closest('.ima-toggle-btn');
            var target = document.querySelector(btn.dataset.target);
            if (target) {
                target.classList.toggle('is-visible');
            }
        }
    });

})();
```

### Scoped Delegation Pattern

```javascript
(function() {
    'use strict';

    // Scoped delegation
    document.querySelectorAll('.ima-component').forEach(function(component) {
        component.addEventListener('click', function(e) {
            var actionBtn = e.target.closest('.ima-action-btn');
            if (actionBtn) {
                e.preventDefault();
                var action = actionBtn.dataset.action;
                var item = actionBtn.closest('.ima-item');
                handleAction(action, item);
            }
        });
    });

})();
```

---

## DOMContentLoaded Patterns

### jQuery Document Ready

```javascript
// Standard WordPress pattern
(function($) {
    $(document).ready(function() {
        // DOM is ready
        initComponents();
    });
})(jQuery);

// Shorthand (equivalent)
jQuery(function($) {
    initComponents();
});
```

### Vanilla DOMContentLoaded

```javascript
(function() {
    'use strict';

    function init() {
        initComponents();
    }

    // Handle both loading states
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        // DOM already loaded (script loaded with defer or at bottom)
        init();
    }

})();
```
