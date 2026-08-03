# AJAX Patterns for WordPress

WordPress AJAX patterns with jQuery and vanilla JS approaches.

## Table of Contents

1. [jQuery AJAX (Recommended)](#jquery-ajax-recommended)
2. [Vanilla fetch Alternative](#vanilla-fetch-alternative)
3. [Error Handling Patterns](#error-handling-patterns)

---

## jQuery AJAX (Recommended)

Standard WordPress AJAX pattern with jQuery:

```javascript
(function($) {
    'use strict';

    function submitForm($form, successCallback, errorCallback) {
        $.ajax({
            url: imaAjax.url,
            type: 'POST',
            data: {
                action: 'ima_process_form',
                nonce: imaAjax.nonce,
                form_data: $form.serialize()
            },
            beforeSend: function() {
                $form.find('button[type="submit"]').prop('disabled', true);
                $form.find('.ima-loading').show();
            },
            success: function(response) {
                if (response.success) {
                    successCallback(response.data);
                } else {
                    errorCallback(response.data || 'Unknown error');
                }
            },
            error: function(xhr, status, error) {
                errorCallback('Network error: ' + error);
            },
            complete: function() {
                $form.find('button[type="submit"]').prop('disabled', false);
                $form.find('.ima-loading').hide();
            }
        });
    }

    // Usage
    $('.ima-ajax-form').on('submit', function(e) {
        e.preventDefault();
        var $form = $(this);

        submitForm(
            $form,
            function(data) {
                $form.find('.ima-response').html(data.message).removeClass('error').addClass('success');
            },
            function(error) {
                $form.find('.ima-response').html(error).removeClass('success').addClass('error');
            }
        );
    });

})(jQuery);
```

---

## Vanilla fetch Alternative

Use when building isolated components without WP plugin interaction:

```javascript
(function() {
    'use strict';

    // Pure function - formats data for WordPress AJAX
    function buildFormData(action, nonce, data) {
        var formData = new FormData();
        formData.append('action', action);
        formData.append('nonce', nonce);

        Object.keys(data).forEach(function(key) {
            formData.append(key, data[key]);
        });

        return formData;
    }

    // Wrapper with side effects
    function submitToWordPress(action, data) {
        return fetch(imaAjax.url, {
            method: 'POST',
            credentials: 'same-origin',
            body: buildFormData(action, imaAjax.nonce, data)
        })
        .then(function(response) {
            if (!response.ok) {
                throw new Error('Network response was not ok');
            }
            return response.json();
        })
        .then(function(data) {
            if (!data.success) {
                throw new Error(data.data || 'Unknown error');
            }
            return data.data;
        });
    }

    // Usage
    document.querySelectorAll('.ima-fetch-form').forEach(function(form) {
        form.addEventListener('submit', function(e) {
            e.preventDefault();

            var formData = new FormData(form);
            var data = {};
            formData.forEach(function(value, key) {
                data[key] = value;
            });

            submitToWordPress('ima_process_form', data)
                .then(function(result) {
                    form.querySelector('.ima-response').textContent = result.message;
                })
                .catch(function(error) {
                    form.querySelector('.ima-response').textContent = error.message;
                });
        });
    });

})();
```

---

## Error Handling Patterns

### Centralized Error Handler

```javascript
(function($) {
    'use strict';

    var AjaxHandler = {
        handleError: function(error, $container) {
            var message = typeof error === 'string' ? error : 'An error occurred';
            $container.find('.ima-response')
                .html(message)
                .removeClass('success')
                .addClass('error');
        },

        handleSuccess: function(data, $container) {
            $container.find('.ima-response')
                .html(data.message || 'Success')
                .removeClass('error')
                .addClass('success');
        }
    };

    window.ImaAjaxHandler = AjaxHandler;

})(jQuery);
```

### Retry Pattern

```javascript
function ajaxWithRetry($form, maxRetries) {
    var attempts = 0;

    function attempt() {
        attempts++;
        return $.ajax({
            url: imaAjax.url,
            type: 'POST',
            data: $form.serialize()
        }).fail(function(xhr, status, error) {
            if (attempts < maxRetries && status === 'timeout') {
                return attempt();
            }
            throw error;
        });
    }

    return attempt();
}
```
