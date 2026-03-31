#!/bin/bash
# Double-click this file to redigitize 206 forms with quality issues.
# It downloads each PDF from va.gov and re-extracts fields with smarter naming.
# Takes ~2-3 minutes (206 forms × 0.5s delay).

cd "$(dirname "$0")"

echo "=================================="
echo "  Fixing pdf-parse version..."
echo "=================================="
rm -rf node_modules/pdf-parse
npm install pdf-parse@1.1.1 pdf-lib 2>/dev/null

echo ""
echo "=================================="
echo "  Running redigitizer v2..."
echo "=================================="
node scripts/redigitize.js --queue

echo ""
echo "=================================="
echo "  Running post-processor..."
echo "  (date composition, field name cleanup, label fixes)"
echo "=================================="
python3 scripts/schema-post-processor.py 2>/dev/null || echo "(Post-processor requires Python 3)"

echo ""
echo "Done! Press any key to close."
read -n 1
