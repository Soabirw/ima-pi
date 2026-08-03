# Loops & Logic (Tangible) — Complete Reference

HTML-like templating language for WordPress dynamic content. Capitalized tags are dynamic (`<Loop>`, `<Field>`), lowercase are standard HTML.

**Docs**: https://docs.loopsandlogic.com/
**In LiveCanvas**: Wrap in `<tangible class="live-refresh">...</tangible>`

## Table of Contents

1. [Syntax Rules](#syntax-rules)
2. [Loop Tag](#loop-tag)
3. [Field Tag](#field-tag)
4. [If/Else Conditions](#ifelse-conditions)
5. [Set/Get Variables](#setget-variables)
6. [Date Tag](#date-tag)
7. [Format Tag](#format-tag)
8. [Math Tag](#math-tag)
9. [List and Map](#list-and-map)
10. [ACF Integration](#acf-integration)
11. [Template Tag](#template-tag)
12. [Utility Tags](#utility-tags)
13. [WooCommerce](#woocommerce)
14. [All Dynamic Tags](#all-dynamic-tags)

---

## Syntax Rules

**Self-closed tags** (no inner content):
```html
<Field title />
<Field name="title" />
```

**Wrapping tags** (contain content):
```html
<Loop type="post"><Field title /></Loop>
```

**Attributes** — quotes optional for simple values:
```html
<Loop type=post count=5 orderby=date>
<Date format="F j, Y" />        <!-- Quotes needed: spaces/special chars -->
```

**Dynamic values in attributes** — use `{}`:
```html
<a href="{Field url}"><Field title /></a>
<img src="{Field image_url}" alt="{Field title}" />
```

---

## Loop Tag

### Post Loop
```html
<Loop type="post" count="5" orderby="date" order="desc">
  <Field title />
</Loop>
```

#### Query Parameters

**Post type & selection**:
| Param | Example | Notes |
|-------|---------|-------|
| `type` | `post`, `page`, `product` | Any post type slug |
| `id` | `42` | Specific post |
| `name` | `hello-world` | By slug |
| `include` | `"1,2,3"` | Specific IDs |
| `exclude` | `"4,5,6"` | Exclude IDs |
| `count` | `10` | Limit results |
| `offset` | `5` | Skip first N |
| `status` | `publish`, `draft` | Post status |
| `sticky` | `true`, `only`, `false` | Sticky post handling |

**Ordering**:
| `orderby` value | Description |
|-----------------|-------------|
| `date` | Publish date (default) |
| `modified` | Last modified |
| `title` | Alphabetical |
| `random` | Random order |
| `menu_order` | Menu/page order |
| `comment_count` | Most commented |
| `id` | By post ID |
| `name` | By slug |
| `author` | By author |
| `relevance` | With search queries |

`order`: `asc` or `desc`

**Author filtering**:
```html
<Loop type=post author="5">
<Loop type=post author="admin">        <!-- By slug -->
<Loop type=post exclude_author="2">
```

**Date filtering**:
```html
<Loop type=post publish_compare="after" publish_date="2 weeks ago">
<Loop type=post publish_year="2024" publish_month="6">
```
`publish_compare`: `before`, `after`, `on`, `not_on`

**Taxonomy filtering**:
```html
<Loop type=post category="news">
<Loop type=post tag="featured">
<Loop type=post taxonomy="genre" terms="comedy,drama">
<Loop type=post taxonomy="color" terms="red" taxonomy_2="size" terms_2="large" taxonomy_relation="AND">
<Loop type=post exclude_category="uncategorized">
```

**Custom field filtering**:
```html
<Loop type=post custom_field="price" custom_field_value="100" custom_field_compare=">=" custom_field_type="numeric">
```
- `custom_field_compare`: `=`, `!=`, `>`, `<`, `>=`, `<=`
- `custom_field_type`: `string`, `numeric`, `date`
- Up to 3 custom fields: `custom_field_2`, `custom_field_value_2`, etc.

**Custom date field filtering**:
```html
<Loop type=post custom_date_field="event_date" custom_date_field_value="today" custom_date_field_compare="after" custom_date_field_format="Y-m-d">
```

**Pagination**:
```html
<Loop type=post paged="10">          <!-- AJAX pagination, 10 per page -->
<Loop type=post search="{Url query=s}">  <!-- Search integration -->
```

### Other Loop Types

**Taxonomy terms**:
```html
<Loop type="taxonomy_term" taxonomy="category" hide_empty="true" orderby="name" parent="0">
  <Field title /> (<Field count />)
</Loop>

<!-- Shortcut for current post's terms -->
<Taxonomy category>
  <Term title />
</Taxonomy>
```

**Users**:
```html
<Loop type="user" role="author" orderby="display_name">
  <Field full_name /> — <Field email />
</Loop>

<!-- Current user shortcut -->
<User full_name />
```

**Attachments**:
```html
<Loop type="attachment">
  <Field url /> — <Field mime_type />
</Loop>
```

**Menus**:
```html
<Loop type="menu" name="primary">
  <a href="{Field url}"><Field title /></a>
</Loop>
```

**Data structures**:
```html
<Loop times="5">Item <Field count /></Loop>
<Loop items="red,green,blue"><Field /></Loop>
<Loop list="my_list"><Field /></Loop>
<Loop map="my_map"><Field key /> = <Field value /></Loop>
```

### Loop Position Helpers

Inside any loop:
```html
<Field count />       <!-- Current iteration (1-based) -->
<Field total />       <!-- Total items -->
<If first>First item</If>
<If last>Last item</If>
<If not last>, </If>  <!-- Comma-separated list -->
```

---

## Field Tag

```html
<!-- Post fields -->
<Field title />
<Field content />
<Field excerpt />
<Field id />
<Field name />                 <!-- Slug -->
<Field url />                  <!-- Permalink -->
<Field edit_url />
<Field publish_date />
<Field modified_date />
<Field status />
<Field author />               <!-- Author ID -->
<Field author_full_name />
<Field author_url />
<Field image />                <!-- Featured image as <img> -->
<Field image_url />
<Field image_url size="thumbnail" />
<Field image_srcset />
<Field image_alt />

<!-- Hierarchical -->
<Field parent />
<Field parent_title />
<Field children_ids />
<Field ancestors />

<!-- From specific post -->
<Field title type="page" name="about" />
<Field title type="post" id="42" />

<!-- Date formatting shortcut -->
<Field publish_date date_format="F j, Y" />

<!-- String operations shortcut -->
<Field phone replace=" " with="-" />

<!-- All custom fields (debugging) -->
<Field all />
```

---

## If/Else Conditions

### Basic Structure
```html
<If field="image" exists>
  Has image
<Else />
  No image
</If>

<If field="color" is value="red">
  Red
<Else if field="color" is value="blue" />
  Blue
<Else />
  Other
</If>
```

### Subjects

| Subject | Example |
|---------|---------|
| `field="name"` | `<If field="price" more_than value="100">` |
| `check="..."` | `<If check="{Get var}" is value="abc">` |
| `count` | `<If count more_than value="2">` |
| `total` | `<If total more_than value="5">` |
| `first` / `last` | `<If first>` |
| `loop` | `<If loop exists type="post" category="news">` |
| `user` | `<If user exists>` (logged in) |
| `user_role` | `<If user_role includes value="administrator">` |
| `user_field="name"` | `<If user_field="email" value="test@test.com">` |
| `route="..."` | `<If route="product/" exists>` |
| `singular` | `<If singular type="product">` |
| `acf_true_false` | `<If acf_true_false="field_name">` |
| `acf_date` | `<If acf_date="start_date" after="today">` |

### Comparisons

| Operator | Description |
|----------|-------------|
| `exists` | Not empty (default when no value) |
| `not_exists` | Is empty |
| `is` | Exact match (default when value given) |
| `is_not` | Does not match |
| `starts_with` | Begins with |
| `ends_with` | Ends with |
| `includes` | Contains |
| `not_includes` | Does not contain |
| `more_than` | Greater than |
| `more_than_or_equal` | >= |
| `less_than` | Less than |
| `less_than_or_equal` | <= |
| `matches_pattern` | Regex match |
| `before` / `after` | Date comparison |
| `before_inclusive` / `after_inclusive` | Date comparison (inclusive) |

### Logic Variables (AND/OR)
```html
<!-- AND: all must be true -->
<Set logic="both" all="true">
  <If field="price" more_than value="100">true<Else />false</If>
  <If field="stock" exists>true<Else />false</If>
</Set>
<If logic="both">Both conditions met</If>

<!-- OR: any true -->
<Set logic="either" any="true">
  <If field="color" is value="red">true<Else />false</If>
  <If field="color" is value="blue">true<Else />false</If>
</Set>
```

### Switch/When
```html
<Switch field="status" is>
  <When value="active" />Active
  <When value="pending" />Pending
  <When value="closed" />Closed
  <When />Unknown
</Switch>
```

---

## Set/Get Variables

```html
<Set name="my_var"><Field title /></Set>
<Get name="my_var" />

<!-- Shorthand -->
<Set my_var><Field title /></Set>
<Get my_var />
```

### Variable Types

| Type | Set | Get | Scope |
|------|-----|-----|-------|
| Regular | `<Set name="x">` | `<Get name="x" />` | Page |
| Local | `<Set local="x">` | `<Get local="x" />` | Template only |
| Template | `<Set template="x">` | `<Get template="x" />` | Reusable fragment |
| Math | `<Set math="x">0</Set>` | `<Get math="x" />` | Math operations |
| Logic | `<Set logic="x">` | `<If logic="x">` | Boolean compound |
| Loop | `<Set loop="x">` | `<Get loop="x" />` | Stored loop |
| Query | `<Set query="x">` | `<Loop query="x">` | Stored query |
| JS | `<Set js="x">` | N/A (Script tab) | Pass to JavaScript |
| Sass | `<Set sass="x">` | N/A (Style tab) | Pass to SCSS |

### Template Variables (Reusable Fragments)
```html
<Set template="card">
  <div class="card h-100">
    <h5 class="card-title"><Field title /></h5>
    <p><Field excerpt /></p>
  </div>
</Set>

<Loop type="post" count="5">
  <Get template="card" />
</Loop>
```

### Passing Variables to Templates
```html
<Template name="my-template" color="red" size="large" />
<!-- Inside template: -->
<Get local="color" />   <!-- red -->
```

---

## Date Tag

```html
<Date />                              <!-- Admin format -->
<Date format="Y-m-d" />              <!-- 2024-07-18 -->
<Date format="F j, Y" />             <!-- July 18, 2024 -->
<Date format="timestamp" />           <!-- UNIX timestamp -->
<Date format="ago" />                 <!-- "3 days ago" -->

<!-- Arithmetic -->
<Date add="1 week" />
<Date subtract="3 days" format="Y-m-d" />
<Date add="1 month">2024-01-15</Date>

<!-- From field -->
<Date format="F j, Y"><Field publish_date /></Date>

<!-- Parse non-standard format -->
<Date from_format="d/m/Y">25/12/2024</Date>

<!-- Locale -->
<Date format="l j F Y" locale="fr" />
```

**PHP format codes**: `Y` (year), `m` (month 01-12), `d` (day 01-31), `H` (hour 24h), `i` (min), `s` (sec), `F` (month name), `M` (short month), `j` (day no zero), `g` (hour 12h), `a` (am/pm), `l` (day name), `D` (short day), `U` (timestamp)

---

## Format Tag

```html
<!-- Case -->
<Format case="upper">hello</Format>              <!-- HELLO -->
<Format case="lower">HELLO</Format>              <!-- hello -->
<Format case="capital">hello world</Format>       <!-- Hello world -->
<Format case="capital_words">hello world</Format> <!-- Hello World -->

<!-- Truncate -->
<Format length="100"><Field content /></Format>
<Format words="20"><Field content /></Format>

<!-- Replace -->
<Format replace=" " with="-">hello world</Format>
<Format replace_pattern="/(\d{3})(\d{4})/" with="$1-$2">1234567</Format>

<!-- Prefix/Suffix -->
<Format prefix="color-">blue</Format>
<Format suffix="-mode">dark</Format>

<!-- Split/Join -->
<Format split=",">red,green,blue</Format>
<Format join=", ">["red","green","blue"]</Format>

<!-- Trim -->
<Format trim>  hello  </Format>
```

---

## Math Tag

```html
<Math>5 + 3</Math>                    <!-- 8 -->
<Math><Field price /> * 1.1</Math>    <!-- price + 10% -->

<!-- Accumulator pattern -->
<Set math="total">0</Set>
<Loop type="post" post_type="product">
  <Math>total = total + <Field custom_field="price" /></Math>
</Loop>
Total: $<Get math="total" />
```

Operators: `+`, `-`, `*`, `/`, parentheses

---

## List and Map

### List
```html
<List name="colors">
  <Item>Red</Item>
  <Item>Green</Item>
  <Item>Blue</Item>
</List>

<Loop list="colors"><Field /></Loop>

<!-- Quick inline -->
<Loop items="red,green,blue"><Field /></Loop>

<!-- Access by index (1-based) -->
<Field list="colors" item="1" />  <!-- Red -->
```

### Map
```html
<Map name="config">
  <Key primary_color>#ff0000</Key>
  <Key site_name>My Site</Key>
</Map>

<Field map="config" key="primary_color" />

<Loop map_keys="config">
  <Field key /> = <Field value />
</Loop>
```

---

## ACF Integration

### Simple Fields
```html
<Field acf_text="field_name" />
<Field acf_textarea="field_name" />
<Field acf_editor="field_name" />       <!-- WYSIWYG -->
<Field acf_email="field_name" />
<Field acf_url="field_name" />
<Field acf_number="field_name" />
```

### Image
```html
<Field acf_image="hero" field="url" />
<Loop acf_image="hero">
  <img src="{Field url}" srcset="{Field srcset}" alt="{Field alt}" />
</Loop>
```

### Gallery
```html
<Loop acf_gallery="photos">
  <img src="{Field url}" alt="{Field alt}" />
</Loop>
```

### File
```html
<a href="{Field acf_file=download field=url}">Download</a>
```

### Link
```html
<Loop acf_link="cta_link">
  <a href="{Field url}" target="{Field target}"><Field title /></a>
</Loop>
```

### Date/Time
```html
<Field acf_date="event_date" />
<Field acf_date="event_date" format="l j F Y" />
<Field acf_date_time="start" />
<Field acf_time="doors_open" />
```

### Choice Fields
```html
<Field acf_select="color" />
<Field acf_radio="size" />

<!-- Multiple select / Checkbox -->
<Loop acf_select="colors"><Field /></Loop>
<Loop acf_checkbox="options"><Field /></Loop>

<!-- Label (when return format is value) -->
<Field acf_select="color" field="label" />
```

### True/False
```html
<If acf_true_false="show_section">
  Section content
</If>
```

### Relational
```html
<Loop acf_post="related_post"><Field title /></Loop>
<Loop acf_relationship="related"><Field title /></Loop>
<Loop acf_taxonomy="categories"><Field title /></Loop>
```

### Repeater
```html
<Loop acf_repeater="team_members">
  <Field name />
  <Field role />
  <img src="{Field acf_image=photo field=url}" />
</Loop>
```

### Group
```html
<Loop acf_group="address">
  <Field street />, <Field city />, <Field state />
</Loop>
```

### Flexible Content
```html
<Loop acf_flexible="page_sections">
  <If field="layout" value="hero">
    <Field acf_editor="content" />
  <Else if field="layout" value="gallery" />
    <Loop acf_gallery="images">
      <img src="{Field url}" />
    </Loop>
  <Else if field="layout" value="cta" />
    <a href="{Field acf_url=link}"><Field acf_text=label /></a>
  </If>
</Loop>
```

### Google Map
```html
<Loop acf_google_map="location">
  <Field address /> (lat: <Field lat />, lng: <Field lng />)
</Loop>
```

---

## Template Tag

```html
<!-- By name or ID -->
<Template name="card-template" />
<Template id="74" />

<!-- Pass variables -->
<Template name="card" color="red" size="large" />

<!-- Theme template parts -->
<Template theme="sidebar" />
<Template theme="part" name="template-parts/footer" />

<!-- Shortcode equivalent -->
[template name="my-template"]
```

---

## Utility Tags

```html
<!-- Site info -->
<Site name />        <Site url />        <Site description />

<!-- URLs -->
<Url site />         <Url current />     <Url query="param" />

<!-- Paths -->
<Path uploads />     <Path theme />

<!-- Settings -->
<Setting timezone_string />    <Setting date_format />

<!-- WordPress shortcode -->
<Shortcode contact-form-7 id="123" title="Contact" />

<!-- Comments (not rendered) -->
<Note>Dev note: this won't appear</Note>

<!-- Raw output (skip L&L processing) -->
<Raw><Loop> would not be processed</Raw>

<!-- Redirect -->
<Redirect url="/login" />

<!-- Route segments -->
<Route />            <Route part="1" />   <Route part="-1" />

<!-- Embed -->
<Embed url="https://youtube.com/watch?v=..." />

<!-- Mobile detect -->
<If mobile_detect="phone">Mobile<Else />Desktop</If>

<!-- Async loading -->
<Async>Heavy content loaded async</Async>

<!-- Caching -->
<Cache name="sidebar" expire="1 hour">Expensive content</Cache>

<!-- Random -->
<Random />

<!-- Exit / Catch -->
<Catch exit>
  <If field="status" is value="disabled"><Exit>Disabled</Exit></If>
  Normal content
</Catch>
```

---

## WooCommerce

Products are `product` post type — query like any CPT:

```html
<Loop type="product" taxonomy="product_cat" terms="shirts" count="6">
  <Field title />
  <img src="{Field image_url}" />
  <a href="{Field url}">View</a>
</Loop>
```

**Product attributes** (stored as `pa_` taxonomies):
```html
<Loop type="taxonomy_term" taxonomy="pa_color" post="current">
  <Field title />
</Loop>
```

**L&L Pro** adds dedicated WooCommerce loop types: `woo_product`, `woo_cart`, `woo_order`, `woo_order_item`, `woo_coupon`, `woo_subscription`, `woo_product_variation`, `woo_product_review`, etc.

---

## All Dynamic Tags

| Tag | Type | Purpose |
|-----|------|---------|
| `Loop` | Wrapping | Query & iterate |
| `Field` | Self-closed | Display field value |
| `If` | Wrapping | Conditional |
| `Set` | Wrapping | Store variable |
| `Get` | Self-closed | Retrieve variable |
| `Date` | Both | Date formatting |
| `Format` | Wrapping | String operations |
| `List` | Wrapping | Array creation |
| `Map` | Wrapping | Associative array |
| `Template` | Self-closed | Render saved template |
| `Shortcode` | Self-closed | WP shortcode |
| `Taxonomy` | Wrapping | Term loop shortcut |
| `Term` | Self-closed | Current term field |
| `User` | Self-closed | Current user field |
| `Url` | Self-closed | URL values |
| `Path` | Self-closed | File paths |
| `Site` | Self-closed | Site info |
| `Setting` | Self-closed | WP settings |
| `Embed` | Self-closed | Media embed |
| `Route` | Both | URL routing |
| `Redirect` | Self-closed | User redirect |
| `Note` | Wrapping | Comment |
| `Raw` | Wrapping | Skip processing |
| `Random` | Self-closed | Random values |
| `Exit` | Self-closed | Stop rendering |
| `Catch` | Wrapping | Catch Exit output |
| `Switch` | Wrapping | Multi-branch |
| `When` | Self-closed | Switch branch |
| `Math` | Both | Arithmetic (module) |
| `Async` | Wrapping | Async loading (module) |
| `Cache` | Wrapping | Caching (module) |
