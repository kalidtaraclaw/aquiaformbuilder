#!/bin/bash
cd "$(dirname "$0")"

echo "=== Committing QA rendering fixes ==="
git add forms.html
git commit -m "Implement 6 QA rendering fixes for digitized VA forms

Fix 1: Name field grouping — detect adjacent firstName/lastName/middleInitial
fields in legacy forms and render them in a single row using the fullname
widget layout (affects 72 forms).

Fix 2: PDF metadata cleanup — strip embedded instructions like 'This Is A
Read Only Field', 'That Autopopulated From Page', 'Do Not Write In This
Space', 'For VA Use Only' from humanized labels. Also strip trailing digits
from field IDs before label generation.

Fix 3: Duplicate label disambiguation — detect fields that humanize to
identical labels and append (2), (3) suffixes to disambiguate.

Fix 4: Auto-sections — forms with >20 fields and no formSections get
auto-grouped by field ID prefix into wizard steps instead of one giant page.

Fix 5: Generic title dedup — skip the 'VA Form [number]' subtitle when
it matches the h1 title exactly, avoiding redundant display.

Fix 6: Signature widget upgrade — replace plain text input with a styled
signature block featuring a sign-here indicator, underline input, and
certification text.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"

echo ""
echo "=== Pushing to GitHub Pages ==="
git push origin main

echo ""
echo "=== Done! ==="
echo "Site will update at: https://kalidtaraclaw.github.io/aquiaformbuilder/"
