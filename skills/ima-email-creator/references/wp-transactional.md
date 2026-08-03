# PHP Email Template Patterns for WordPress

## Architecture: Pure Function + WordPress Wrapper

The IMA codebase separates email generation from sending:
- **Pure functions** generate HTML/text with zero WordPress dependencies (testable)
- **WordPress wrappers** handle side effects (wp_mail, user lookups, logging)

## Brand Alignment Note

WordPress transactional emails use the **ima-brand plugin colors**: `#00066F` Indigo headers, `#00B8B8` Aquatic Pulse CTAs, `#494949` Gravel text — applied via `ima_brand_email_wrapper()`.

Marketing emails (BeeFree/EspoCRM drip and campaign) are now aligned to the same brand book colors: `#00B8B8` Aquatic Pulse CTAs, `#494949` Gravel text — replacing the old `#0296a1`/`#374751` palette. The only distinction is that transactional emails also use `#00066F` Indigo for headers (via `ima_brand_email_wrapper()`), which marketing email templates handle in their own header blocks.

## The Brand Wrapper

`ima_brand_email_wrapper()` from `ima-brand` plugin provides:
- Consistent outer HTML structure (header with logo, footer)
- Brand colors and typography
- Location: `wp-content/plugins/ima-brand/includes/email-template.php`

```php
$html = ima_brand_email_wrapper($inner_html, $subject);
```

## Pure Template Pattern

```php
// inc/pure/email-templates.php
declare(strict_types=1);

function ima_build_invitation_email(array $data): string {
    // Pure function — no WordPress calls, no side effects
    $name = htmlspecialchars($data['name'], ENT_QUOTES, 'UTF-8');
    // ... build HTML with inline styles ...
    return $html;
}
```

## WordPress Wrapper Pattern

```php
// inc/invitation-emails.php
function ima_send_invitation_email(int $user_id, string $code): bool {
    $user = get_userdata($user_id);
    $html = ima_build_invitation_email([
        'name' => $user->display_name,
        'code' => $code,
    ]);
    $wrapped = ima_brand_email_wrapper($html, 'Your Invitation');
    return wp_mail($user->user_email, 'Your Invitation', $wrapped, [
        'Content-Type: text/html; charset=UTF-8',
    ]);
}
```

## Existing Email Modules

| Module | Location | Purpose |
|--------|----------|---------|
| Invitations | child theme `inc/pure/email-templates.php` | Invitation, activation, application emails |
| Payments | `ima-payments` plugin | Receipt emails with PDF attachments |
| Memberships | `ima-memberships` plugin | Retention and welcome emails |
| Registration | `ima-registration` plugin | Email verification codes |
| Contact forms | `ima-forms` plugin | Form submission notifications |

## Key Rules

- Always escape: `htmlspecialchars($value, ENT_QUOTES, 'UTF-8')`
- Set content type header: `Content-Type: text/html; charset=UTF-8`
- Use `do_action('ima_log_info', 'Email sent to: ' . $email)` for logging
- Plain text fallback via `wp_mail` multipart (optional but good practice)

## When to Use This vs. Newsletter/Campaign

- **This pattern**: System-triggered emails (verification, receipts, notifications) — lives in PHP, runs in WordPress
- **Newsletter/Campaign**: Marketing emails rendered from this skill, pasted into EspoCRM — platform-agnostic HTML
