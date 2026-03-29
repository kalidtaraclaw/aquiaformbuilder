# VA.gov BIO Component Pattern Reference

This file documents the verified component patterns from VA.gov Benefits Intake Online (BIO) forms. These patterns are the ground truth for QA validation. All values are sourced from production VA.gov BIO form code (e.g., 21-4192, 21-0779).

## Table of Contents
1. [Design Tokens](#design-tokens)
2. [Typography](#typography)
3. [Buttons & Navigation](#buttons--navigation)
4. [Action Link (Start CTA)](#action-link)
5. [Progress Bar](#progress-bar)
6. [Form Fields](#form-fields)
7. [Review Accordions](#review-accordions)
8. [Page Structure](#page-structure)
9. [Alerts & Messages](#alerts--messages)

---

## Design Tokens

These are the VADS (VA Design System) color tokens. The form must use these exact values:

| Token | Hex | Usage |
|---|---|---|
| `--vads-color-primary` | `#005ea2` | Links, active tab borders, primary UI |
| `--vads-color-primary-dark` | `#1a4480` | Hover states on primary elements |
| `--vads-color-primary-darker` | `#162e51` | VA header background |
| `--vads-color-secondary` | `#d83933` | Error states, required indicators |
| `--vads-color-base` | `#1b1b1b` | Body text |
| `--vads-color-base-dark` | `#565c65` | Secondary text |
| `--vads-color-base-lighter` | `#dfe1e2` | Borders |
| `--vads-color-base-lightest` | `#f0f0f0` | Background fills |
| `--vads-color-success` | `#00a91c` | Action link, success states |
| `--vads-color-warning` | `#ffbe2e` | Warning alerts |
| `--vads-color-error` | `#d54309` | Error messages |
| `--vads-color-info` | `#00bde3` | Info alerts |

## Typography

- **Font family (sans)**: `'Source Sans 3'` with fallbacks `'Helvetica Neue', Helvetica, Arial, sans-serif`
- **Font family (serif)**: `'Bitter'` with fallbacks `Georgia, 'Times New Roman', serif`
- **Body text**: 16px, line-height 1.625
- **H1 (page title)**: `font-family: var(--vads-font-serif)`, `font-size: 2rem`, `font-weight: 700`, `line-height: 1.2`
- **H2 (section)**: `font-size: 1.35rem`, `font-weight: 700`
- **H3 (subsection)**: `font-size: 1.15rem`, `font-weight: 700`

## Buttons & Navigation

### Continue Button (Primary)
- Class: `.va-btn--primary`
- Background: `var(--vads-color-primary)` → `#005ea2`
- Text: white, `font-weight: 700`
- Padding: `0.75rem 2rem`
- Border-radius: `5px`
- **Arrow**: `::after { content: ' \u203A'; font-size: 1.2em; }` — This IS correct. The right single guillemet (›) appears AFTER the text.

### Back Button (Secondary)
- Class: `.va-btn--back`
- Background: transparent
- Border: `2px solid var(--vads-color-primary)`
- Color: `var(--vads-color-primary)`
- **Arrow**: `::before { content: '\u2039 '; font-size: 1.2em; }` — This IS correct. The left single guillemet (‹) appears BEFORE the text.

### Button Group Layout
- Class: `.va-nav-buttons`
- `display: flex`, `gap: 1rem`, `margin-top: 2rem`

## Action Link

The green "Start" CTA that appears on the intro page. Matches VA.gov `<VaLinkAction>` component.

- Class: `.va-action-link`
- Color: `var(--vads-color-success)` → `#00a91c` — **Green IS correct** per BIO pattern
- Font: `font-weight: 700`, `font-size: 1.15rem`
- Hover: `color: #008516`
- **Circular badge**: `::before` pseudo-element with:
  - `width: 2rem`, `height: 2rem`
  - `border-radius: 50%`
  - `background: var(--vads-color-success)` (green circle)
  - Content: white play triangle (`▶`, color: white, font-size: 0.7rem)
- Hover badge: `background: #008516`

## Progress Bar

Segmented progress bar matching VA.gov `va-segmented-progress-bar`.

- Class: `.va-progress-bar`
- **NOT shown on intro page** — this is important; intro pages never have progress bars
- Container: `display: flex`, `gap: 3px`, `margin-bottom: 0.5rem`
- Segments: equal-width divs, `height: 8px`, `border-radius: 99px`
- Active segment: `background: var(--vads-color-primary)` → blue
- Inactive segment: `background: var(--vads-color-base-lighter)` → gray
- Step counter text below: `"Step X of Y: Section Name"`, `font-weight: 700`

## Form Fields

### Text Input
- Class: `.va-input`
- Border: `2px solid var(--vads-color-base-dark)` → `#565c65`
- Border-radius: `0` (square corners per USWDS)
- Padding: `0.5rem`
- Focus: `border-color: var(--vads-color-primary)`, `outline: 3px solid #73b3e7`
- Width: `100%`

### Label
- `font-weight: 700`, `margin-bottom: 0.35rem`

### Required indicator
- Text `(*Required)` in `color: var(--vads-color-secondary)` → red

### Textarea
- Same styling as text input, `min-height: 5rem`

### Select (Dropdown)
- Same border/padding as text input
- Appearance reset with custom dropdown arrow

### Checkbox / Radio
- Custom styled with VADS colors
- Labels inline with inputs

## Review Accordions

Used on the review page before submission.

- Header class: `.va-review-accordion-header`
- **Must have**: `aria-expanded="false"` attribute (toggled to `"true"` on open)
- Icon: Chevron/caret that **rotates on expand** via `transform: rotate(180deg)`
- Content panel: hidden by default, slides open on toggle
- Edit button within accordion to return to that section

## Page Structure

### US Government Banner
- Class: `.usa-banner`
- Background: `var(--vads-color-base-lightest)`
- Contains US flag icon + "An official website of the United States government"

### VA Header
- Class: `.va-header`
- Background: `var(--vads-color-primary-darker)` → `#162e51`
- VA logo image (40px height)
- Navigation links in header right area

### Page Flow
1. **Intro page**: Title, description, action link (green start button), no progress bar
2. **Form pages**: Progress bar, section title, form fields, Back/Continue buttons
3. **Review page**: Accordions for each section, Submit button
4. **Confirmation page**: Success alert, submission details

### Breadcrumb
- Class: `.va-breadcrumb`
- Format: `VA.gov home › Section › Form title`
- Separator: `›` (U+203A)

## Alerts & Messages

### Alert Box
- Classes: `.va-alert`, `.va-alert--info`, `.va-alert--warning`, `.va-alert--error`, `.va-alert--success`
- Left border: `4px solid` in the corresponding color
- Background: lighter variant of the color
- Contains heading and body text

### Error Message (Field-level)
- Class: `.va-error-message`
- Color: `var(--vads-color-error)` → `#d54309`
- Font-weight: `700`
- Appears below the field label, above the input
