# Newsletter Layout Reference

HTML structure patterns for newsletters, campaigns, fundraising, and webinar promo emails. IMA-branded.

## Common Structure (BeeFree DOM)

```
body (background: #F2F3F5)
  └── nl-container table (100% width, role="presentation")
      └── row table (100% width, center-aligned)
          └── row-content stack table (600px, margin: 0 auto, background: #FFFFFF)
              └── column column-1 td (100%)
                  └── col-pad td (padding)
                      └── [content block tables]
```

Content block class names: `image_block`, `heading_block`, `paragraph_block`, `button_block`, `divider_block`, `list_block`, `html_block`, `social_block`

## Preheader Pattern

```html
<div style="display:none;font-size:1px;color:#ffffff;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
  Preview text here (50-100 chars for inbox)
</div>
```

## CTA Button Pattern (VML hybrid, Outlook-safe)

```html
<a href="URL" target="_blank" style="color: #ffffff; text-decoration: none;">
  <!--[if mso]>
  <v:roundrect style="height:42px;width:122px;v-text-anchor:middle;" arcsize="10%" fillcolor="#00B8B8">
    <v:stroke dashstyle="Solid" weight="0px" color="#00B8B8"/>
    <w:anchorlock/>
    <v:textbox inset="0px,0px,0px,0px">
      <center style="color:#ffffff;font-family:Arial, Helvetica, sans-serif;font-size:16px">
  <![endif]-->
  <span class="button" style="background-color:#00B8B8;border-radius:4px;color:#ffffff;display:inline-block;font-family:Lato,Arial,Helvetica,sans-serif;font-size:16px;font-weight:500;text-align:center;word-break:keep-all;">
    <span class="btn-pad" style="padding:5px 10px;display:block;">
      <span style="word-break:break-word;line-height:32px;">Read <strong>More »</strong></span>
    </span>
  </span>
  <!--[if mso]></center></v:textbox></v:roundrect><![endif]-->
</a>
```

Note: VML width varies per button text. CTA text uses `»` (raquo) chevron. "More" is bold.

## Section Divider Pattern

```html
<table class="divider_block" width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
  <tr>
    <td class="divider_inner" style="border-top:1px solid #dddddd;font-size:1px;line-height:1px;">&#8202;</td>
  </tr>
</table>
```

Note: Uses `&#8202;` (hair space), not `&nbsp;`.

## Content Block Repeating Pattern

```
heading_block (h1, 20px emoji + title, color:#00066F, font: Lato, Arial, Helvetica, sans-serif)
  → image_block (580px, border-radius 5px, linked)
  → paragraph_block (16px body text, color #494949, font: "Open Sans", "Helvetica Neue", Helvetica, Arial, sans-serif)
  → button_block (VML hybrid CTA)
  → divider_block (#dddddd)
```

## Colors & Fonts

Colors — CTA: `#00B8B8` | Body text: `#494949` | Outer background: `#F2F3F5` | Inner container: `#FFFFFF` | Dividers: `#dddddd` | Footer: `#919396` | H1: `#00066F`

Fonts — Headings: `Lato, Arial, Helvetica, sans-serif` | Body: `"Open Sans", "Helvetica Neue", Helvetica, Arial, sans-serif`

## Attribution and remote assets

Approved UTM attribution may be used, for example:
`?utm_term=YYYY-MM-DD&utm_medium=email&utm_source=bulk-mailer&utm_content=slug&utm_campaign=__UTM_CAMPAIGN__`

Resolve `__UTM_CAMPAIGN__` before distribution. Templates may reference approved HTTPS assets, but helpers do not fetch, upload, host, or configure tracking for them. Use meaningful alt text and never place secrets, recipient IDs, or tokens in URLs.

## EspoCRM Variables

Single-brace syntax: `{Person.firstName}`, `{Person.name}`, `{optOutLink}`

## Newsletter Layout

1. **Preheader** — preview text
2. **Header** — IMA logo (horizontal lockup, 200px min width)
3. **Opening hook** — `{Person.firstName}` greeting, 2-3 sentences, personality-forward
4. **Quick Links** — emoji + title list (3-6 items)
5. **Content sections** (3-6) — emoji header, 2-3 sentence summary, "Read More »" CTA
6. **Support footer** — "PLEASE SUPPORT HONEST MEDICINE" + donate CTA
7. **Standard footer** — disclaimer, `{optOutLink}`, address

## Fundraising / Campaign Layout

1. **Preheader**
2. **Header** with logo
3. **Emotional headline** (h1)
4. **Donate CTA above fold** — "💙 Match My Gift Today »" (or "💙 Please Donate »")
5. **Salutation** — "Dear {Person.name}"
6. **Problem/solution narrative** — 2-3 paragraphs
7. **Pull quote** from named leader
8. **"Why Your Support Matters"** — 3-4 bullets
9. **"Your Gift Powers What's Next"** — 4 bullets with specific dollar amounts
10. **Signoff** with full credentials + P.S. with deadline + repeat CTA
11. **Footer**

Note: If match campaign, repeat "EVERY DOLLAR DOUBLED" 2-3 times.

## Webinar / Resource Promo Layout

1. **Preheader** → **Header**
2. **"Watch Now!" header** (h1) + hook headline
3. **Context** — 3-4 sentences with tension
4. **"In this episode, you'll learn:"** — 3 surprising bullets
5. **Expert attribution** — name, credentials, affiliation
6. **"👉 Watch Now »" / "Download Now »"** CTA → **Footer**

## Journal / Institutional Layout

Static only — no template variables. Institutional tone. CTAs: "Submit a Paper »" / "Get Tickets »"

1. **Preheader** → **Header** → **Headline + subhead**
2. **Content sections** — article summaries or event details
3. **CTA block** → **Footer**
