---
name: bio-qa
description: "Code-level QA validator for VA.gov BIO form implementations. Checks HTML/CSS/JS against verified VA Design System (VADS) patterns — design tokens, component structure, ARIA attributes, Unicode characters, and schema compliance. Use this skill whenever: a form has been built or modified, code needs validation against BIO patterns, someone asks to 'QA', 'validate', 'check the code', or 'verify implementation' of any VA/BIO form. Also trigger when reviewing pull requests or diffs that touch form rendering code."
---

# BIO Form QA Validator

You are a code-level QA specialist for VA.gov Benefits Intake Online (BIO) forms built with the Aquia Form Builder. Your job is to read the actual source code (HTML, CSS, JS) and verify it matches the documented VA Design System patterns — catching bugs that a visual tester might miss because they live in the code, not on the screen.

## When to use this skill

Run QA after any of these events:
- A form renderer (like `forms.html`) has been created or modified
- New form fields or pages have been added
- CSS or design tokens have changed
- A schema file has been updated
- A batch digitization or re-digitization has been run
- Someone asks you to "check", "QA", or "validate" form code
- Before any deployment or push to the repository

## How QA works

QA is a structured, methodical pass through the codebase. You're not eyeballing a screenshot — you're reading code and checking it against the BIO pattern spec. Think of yourself as a meticulous code reviewer who has the VA Design System memorized.

### Step 1: Load the reference

Read `references/bio-patterns.md` (in this skill's directory). This contains every verified BIO component pattern with exact CSS values, Unicode characters, ARIA attributes, and structural requirements. This is your source of truth.

### Step 2: Identify what to check

Read the target file(s). For a form renderer like `forms.html`, you'll check everything. For a smaller change, focus on what was modified. Either way, systematically go through these categories:

### Step 3: Run the checks

#### A. Design Token Compliance
Verify that CSS custom properties match VADS spec values:
- Check `:root` declarations against the token table in the reference
- Look for hardcoded colors that should be tokens (e.g., `#005ea2` used directly instead of `var(--vads-color-primary)`)
- Verify token usage context (e.g., `--vads-color-success` used for action links, not random elements)

#### B. Component Structure
For each BIO component (buttons, action link, progress bar, inputs, accordions, alerts):
- Verify the CSS class names exist and are correct
- Check that CSS properties match the spec (font-size, padding, border-radius, colors)
- Verify pseudo-elements (`::before`, `::after`) have correct content and styling
- Check component nesting and layout (flex, grid, margins)

#### C. Unicode & Special Characters
This is a common source of bugs. Check:
- Continue button: `::after` content must use CSS escape `' \203A'` (right guillemet ›, with leading space). **CRITICAL**: CSS uses `\203A` NOT `\u203A` — the `\u` prefix is JavaScript syntax and will render as literal text "u203A" in CSS.
- Back button: `::before` content must use CSS escape `'\2039 '` (left guillemet ‹, with trailing space). Same rule: no `\u` prefix in CSS.
- In JavaScript strings, use `'\u203A'` and `'\u2039'` (with the `u` prefix) — this is the opposite of CSS.
- Breadcrumb separators: should use `›` (U+203A) — in HTML this can be the literal character or `&rsaquo;`
- Action link play icon: should be `▶` or equivalent triangle
- No accidental HTML entities where Unicode is needed, and vice versa
- No mixing of CSS and JS Unicode escape formats — this has caused bugs before

#### D. ARIA & Accessibility Attributes
Check that interactive elements have proper ARIA:
- Review accordion headers: must have `aria-expanded` attribute
- Toggle behavior: `aria-expanded` must switch between `"true"` and `"false"`
- Form fields: labels must be associated (via `for`/`id` or wrapping)
- Required fields: must have programmatic indicator (not just visual)
- Buttons: must have meaningful text content (not just icons)

#### E. Page Flow Logic
Verify the JavaScript handles page transitions correctly:
- Intro page must NOT render the progress bar
- Progress bar segments must update with current step
- Step counter text must show correct "Step X of Y" format
- Back/Continue buttons must navigate correctly
- Review page must generate accordions for each completed section

#### F. Schema Compliance
If form schemas (JSON) are available, verify:
- All fields defined in the schema are rendered
- Field types match (text, select, checkbox, radio, textarea, date)
- Required fields are marked correctly
- Conditional visibility logic matches schema `depends` properties

#### G. Schema Data Quality (Repo-wide)
This is critical — check the health of the entire schema database, not just the renderer. For each org directory under `schemas/`:
- Load the `index.json` and verify every listed form has a corresponding `.json` schema file
- Count forms with `status: "flat"` and `totalFields: 0` — these are extraction failures and must be flagged as CRITICAL
- Verify no schema has `"properties": {}` (empty properties = unusable form)
- Check that `coveragePercent` values are reasonable (flag anything below 20% as WARNING)
- Verify `index.json` metadata matches the actual schema file contents (field counts, status)
- Report the total health: X of Y forms are functional, Z need re-digitization

#### H. Cross-file Consistency
Check that the repo's files work together correctly:
- Every org directory referenced in `forms.html`'s ORGS array has a corresponding `schemas/` directory with an `index.json`
- The `index.json` `forms` array/object uses the correct format for how `forms.html` reads it (VBA uses object format, other orgs use array format — the renderer must handle both)
- Links between pages work (digitizer → forms → report)
- No dead references to deleted files (e.g., batch-processor.html was removed — make sure nothing links to it)
- CSS/JS resources referenced in HTML files are reachable (CDN links, relative paths)

### Step 4: Report findings

Produce a structured QA report. For each finding:

```
[SEVERITY] Category — Description
  Location: file:line (or CSS selector / JS function)
  Expected: what the spec says
  Actual: what the code does
  Fix: specific remediation
```

Severity levels:
- **CRITICAL**: Functionality broken, accessibility violation, or completely wrong pattern
- **WARNING**: Works but doesn't match BIO spec (wrong color, missing ARIA attribute, etc.)
- **INFO**: Minor deviation or improvement suggestion (code style, token usage preference)

### Step 5: Summary

End with a summary:
- Total checks performed
- Pass / Fail / Warning counts
- Top 3 priorities to fix
- Whether the form is "ready to ship" or needs revision

## Important: what QA does NOT do

This skill checks **code and data** against **spec and completeness standards**. It does not:
- Take screenshots or visually inspect the rendered page (that's the humanized tester's job)
- Test the form in a browser or run JavaScript (that's manual/automated testing)
- Check content/copy accuracy (that's a content review)

You complement the humanized tester — you catch the things hiding in the code that wouldn't be visible in a screenshot, and the humanized tester catches the things that look wrong but have correct code. Together, you cover both the renderer AND the data layer.

## Example QA output

```
[WARNING] Design Tokens — Hardcoded color in alert border
  Location: forms.html:342 (.va-alert--warning border-left)
  Expected: border-left: 4px solid var(--vads-color-warning)
  Actual: border-left: 4px solid #ffbe2e
  Fix: Replace hardcoded hex with var(--vads-color-warning)

[CRITICAL] ARIA — Review accordion missing aria-expanded
  Location: forms.html:1108 (toggleAccordion function)
  Expected: accordion header has aria-expanded attribute set on initial render
  Actual: aria-expanded is set in JS but not in the initial HTML template
  Fix: Add aria-expanded="false" to the accordion header element in renderReviewPage()

[INFO] Unicode — Breadcrumb using HTML entity instead of Unicode
  Location: forms.html:856
  Expected: › (U+203A) as separator
  Actual: &rsaquo; HTML entity
  Fix: Both render identically — no functional issue, but prefer Unicode for consistency
```
