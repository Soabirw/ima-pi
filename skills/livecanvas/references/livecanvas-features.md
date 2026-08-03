# LiveCanvas Features Reference

LiveCanvas v4.9+ — premium WordPress page builder. Bootstrap-native, HTML-first, zero CSS/JS overhead.

**Docs**: https://docs.livecanvas.com/

## Table of Contents

1. [Editor Workflow](#editor-workflow)
2. [Content Storage](#content-storage)
3. [LiveCanvas Shortcodes](#livecanvas-shortcodes)
4. [WooCommerce Shortcodes](#woocommerce-shortcodes)
5. [Forms API](#forms-api)
6. [Template Assignment](#template-assignment)
7. [Reusable Sections](#reusable-sections)
8. [Editor Features](#editor-features)

---

## Editor Workflow

LiveCanvas edits pages on the frontend. The editor provides:

- **Tree View**: DOM structure visualization
- **Code Editor**: Full HTML editor with Emmet support
- **Responsive Preview**: XS (412px), SM (576px), MD (768px), LG (992px), XL (1200px), XXL (1400px)
- **Properties Panel**: ID, class, style always pinned at top
- **Grid Builder**: Divide horizontal space into responsive columns
- **Universal Selection**: Click any element to select and edit
- **Undo/Redo**: Full step history
- **Unsplash Integration**: Free image search
- **AI Assistant**: Supports OpenAI, Claude, Gemini, Grok (via OpenRouter)

### Editable Attributes
```html
<h1 editable="inline">Single-line text</h1>
<div editable="rich">Rich text with formatting toolbar</div>
```

### The lc-block
Smallest building unit:
```html
<div class="lc-block">
  <h2 editable="inline">Heading</h2>
  <p editable="rich">Paragraph content</p>
</div>
```

---

## Content Storage

Content is stored in the WordPress database as plain HTML:
- Page HTML → `wp_posts.post_content`
- LiveCanvas flag → `wp_postmeta`
- Empty page template assigned to the page
- Global CSS → stored separately (Options > Edit Global CSS)
- Reusable sections → custom post type

**No vendor lock-in**: Disable plugin and content remains as HTML in the database.

---

## LiveCanvas Shortcodes

### Post/Page Data
```
[lc_the_title]                          Post title
[lc_the_content]                        Full content
[lc_the_excerpt]                        Excerpt
[lc_the_date format="F j, Y"]          Publish date
[lc_the_date type="modified"]           Modified date
[lc_the_permalink]                      Post URL
[lc_the_author field="display_name"]    Author info
[lc_the_thumbnail size="large"]         Featured image
[lc_the_cf field="field_name"]          Custom field value
```

### Taxonomy
```
[lc_the_terms taxonomy="category" separator=", "]
[lc_the_categories separator=", " link="true"]
[lc_the_tags separator=", "]
```

### Site Options
```
[lc_the_option option="blogname"]       Site name
[lc_the_option option="blogdescription"] Tagline
[lc_the_option option="siteurl"]        Site URL
```

### Conditional
```
[lc_if condition="is_user_logged_in"]
  Welcome back!
[/lc_if]

[lc_if condition="is_single"]
  Single post content
[/lc_if]
```
Calls WordPress conditional functions: `is_user_logged_in`, `is_single`, `is_page`, `is_home`, `is_front_page`, `is_archive`, `is_category`, `is_tag`, `is_search`, `is_404`, etc.

### Post Query Loop
```
[lc_get_posts post_type="post" posts_per_page="3" orderby="date" order="DESC" category_name="news"]
  <h3>[lc_the_title]</h3>
  <p>[lc_the_excerpt]</p>
  <a href="[lc_the_permalink]">Read more</a>
[/lc_get_posts]
```

### Translation
```
[lc_i18n]Translatable string[/lc_i18n]
```

### Function Call
```
[lc_function name="function_name" arg1="value"]
```

### Template Part
```
[lc_get_template_part slug="template-parts/content" name="single"]
```

### Pagination
```
[lc_the_pagination]
```

### Comments
```
[lc_the_comments]
```

### Reusable Section
```
[lc_html_section id="123"]
```

---

## WooCommerce Shortcodes

Enable WooCommerce support in LiveCanvas backend settings.

### Product Data
```
[lc_wc_product data="title"]
[lc_wc_product data="price"]               Regular + sale price HTML
[lc_wc_product data="regular_price"]
[lc_wc_product data="sale_price"]
[lc_wc_product data="description"]
[lc_wc_product data="short_description"]
[lc_wc_product data="sku"]
[lc_wc_product data="stock_status"]
[lc_wc_product data="stock_quantity"]
[lc_wc_product data="weight"]
[lc_wc_product data="dimensions"]
[lc_wc_product data="average_rating"]
[lc_wc_product data="review_count"]
```

### Product Components
```
[lc_wc_carousel]                            Product image carousel (Bootstrap 5)
[lc_wc_product_add_to_cart]                 Add to cart form
[lc_wc_notices]                             WooCommerce notices
[lc_wc_product_rating]                      Star rating with review link
[lc_wc_product_tab_description]             Description tab content
[lc_wc_product_tab_additional_information]  Additional info tab
[lc_wc_product_tab_reviews]                 Reviews + form
[lc_wc_related]                             Related products
[lc_wc_on_sale_badge]                       Sale badge
```

### Shop/Archive Components
```
[lc_wc_add_to_cart]                         Loop add-to-cart button
[lc_wc_order_by]                            Product sorting dropdown
[lc_wc_result_count]                        "Showing X of Y results"
[lc_wc_sidebar]                             Shop sidebar/filters
```

### WooCommerce Blocks & URLs
```
[lc_wc_block block="mini-cart"]             WC Gutenberg block
[lc_wc_get_page_url page="cart"]            Cart URL
[lc_wc_get_page_url page="checkout"]        Checkout URL
[lc_wc_get_page_url page="myaccount"]       My Account URL
[lc_wc_get_page_url page="shop"]            Shop URL
```

### Labels
```
[lc_wc_label label="add_to_cart"]           Translatable WC labels
```

### Supported Template Types
- Single Product
- Product Category/Archive
- Shop Page
- Cart, Checkout
- Per-category templates (e.g., "shoes" vs "hats")

---

## Forms API

LiveCanvas provides AJAX form handling via shortcode:

```html
[lc_form action="my_custom_action"]
  <div class="mb-3">
    <label class="form-label">Name</label>
    <input type="text" name="name" class="form-control" required />
  </div>
  <div class="mb-3">
    <label class="form-label">Email</label>
    <input type="email" name="email" class="form-control" required />
  </div>
  <button type="submit" class="btn btn-primary">Submit</button>
[/lc_form]
```

Handle in PHP via standard WordPress AJAX hooks:
```php
add_action('wp_ajax_my_custom_action', 'handle_my_form');
add_action('wp_ajax_nopriv_my_custom_action', 'handle_my_form');

function handle_my_form() {
    $name = sanitize_text_field($_POST['name']);
    $email = sanitize_email($_POST['email']);
    // Process form...
    wp_send_json_success(['message' => 'Thank you!']);
}
```

---

## Template Assignment

LiveCanvas can handle WordPress templates (enable "Handle WordPress Templates" in settings).

**Target any WordPress view**:
- Single post/page (per post type)
- Archive (per post type, per category, per taxonomy)
- Search results
- 404 page
- WooCommerce pages (product, shop, cart, checkout)
- Author archive
- Date archive
- Front page / blog page

**Granular rules**: Assign different templates per category, per post type, per taxonomy term.

---

## Reusable Sections

### Saving
Select any `<section>` in the editor → Save to personal library.

### Using
```html
[lc_html_section id="123"]
```
Or in PHP:
```php
echo do_shortcode('[lc_html_section id="123"]');
```

### Storage
- Stored as a custom post type in WordPress
- Edits propagate to all pages using the section
- Can also store custom sections in child theme: `/livecanvas/sections/`

### Child Theme Pages
Store readymade page templates in: `/livecanvas/pages/`

---

## Editor Features

### Keyboard Shortcuts
See: https://docs.livecanvas.com/keyboard-shortcuts/

### Emmet Support
The code editor supports Emmet abbreviations for rapid HTML generation:
```
div.container>div.row>div.col-md-6*2>div.lc-block
```

### Export
Download any page as standalone HTML file.

### Section Library
- Built-in readymade sections (Bootstrap-based)
- Dynamic Posts Loop sections (rebuilt in v4.8+ with Tangible syntax)
- Community sections
- Child theme custom sections

### AI Assistant
Supports multiple providers via API key:
- OpenAI
- Anthropic Claude
- Google Gemini
- xAI Grok (via OpenRouter)
