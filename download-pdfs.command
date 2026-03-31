#!/bin/bash
# Double-click this file to download all 551 VA form PDFs for local reference.
# PDFs are saved to the pdfs/ directory, organized by source organization.
# Takes ~5-10 minutes depending on connection speed.

cd "$(dirname "$0")"

echo "=================================="
echo "  VA Form PDF Downloader"
echo "=================================="
echo ""

# Create pdfs directory
mkdir -p pdfs

# Count total
TOTAL=$(python3 -c "
import json, os
count = 0
for root, dirs, files in os.walk('schemas'):
    for f in sorted(files):
        if f.endswith('.json') and f != 'index.json':
            try:
                with open(os.path.join(root, f)) as fh:
                    s = json.load(fh)
                url = s.get('x-va-metadata', {}).get('formUrl', '')
                if url: count += 1
            except: pass
print(count)
")

echo "Found $TOTAL forms with PDF URLs"
echo ""

# Download each PDF
python3 << 'PYEOF'
import json, os, urllib.request, urllib.error, time, sys

schemas_dir = "schemas"
pdfs_dir = "pdfs"
downloaded = 0
skipped = 0
failed = 0
total = 0

for root, dirs, files in os.walk(schemas_dir):
    for f in sorted(files):
        if not f.endswith('.json') or f == 'index.json':
            continue
        path = os.path.join(root, f)
        try:
            with open(path) as fh:
                s = json.load(fh)
            meta = s.get('x-va-metadata', {})
            url = meta.get('formUrl', '')
            form_name = s.get('title', f.replace('.json', ''))
            if not url:
                continue
            total += 1

            # Determine output filename
            pdf_name = f"{form_name}.pdf"
            pdf_path = os.path.join(pdfs_dir, pdf_name)

            # Skip if already downloaded
            if os.path.exists(pdf_path) and os.path.getsize(pdf_path) > 1000:
                skipped += 1
                sys.stdout.write(f"\r  [{skipped + downloaded}/{total}] Skipped (exists): {form_name}    ")
                continue

            # Download
            try:
                req = urllib.request.Request(url, headers={
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
                })
                with urllib.request.urlopen(req, timeout=30) as resp:
                    data = resp.read()
                with open(pdf_path, 'wb') as out:
                    out.write(data)
                downloaded += 1
                sys.stdout.write(f"\r  [{skipped + downloaded}/{total}] Downloaded: {form_name}    ")
            except Exception as e:
                failed += 1
                sys.stdout.write(f"\r  [{skipped + downloaded + failed}/{total}] FAILED: {form_name}: {e}    ")

            # Small delay to be polite
            time.sleep(0.3)

        except Exception as e:
            pass

print(f"\n\nDone!")
print(f"  Downloaded: {downloaded}")
print(f"  Skipped (already existed): {skipped}")
print(f"  Failed: {failed}")
print(f"  Total: {total}")
PYEOF

echo ""
echo "PDFs saved to: pdfs/"
echo ""
echo "Done! Press any key to close."
read -n 1
