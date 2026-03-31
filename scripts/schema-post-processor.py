#!/usr/bin/env python3
"""
Schema Post-Processor — Fixes deterministic quality issues in VA form schemas.

Handles:
1. Compose date fragments (dateXYear + dateXMonth + dateXDay → dateX)
2. Remove duplicate fields that differ only in case
3. Fix format mismatches on date fragments
4. Flag (but don't auto-fix) raw XFA and generic names for redigitization

Run: python3 scripts/schema-post-processor.py [--dry-run] [--form FORM_NAME]
"""

import json
import os
import re
import sys
import argparse
from collections import defaultdict
from pathlib import Path
from datetime import datetime, timezone

SCHEMAS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "schemas")

# Patterns
DATE_FRAGMENT_RE = re.compile(r'^(.*?)(Year|Month|Day)\d*$', re.IGNORECASE)
XFA_RAW_RE = re.compile(
    r'^(topmostSubform|Page\d+|Subform\d+|Table\d+|Row\d+|Cell\d+|'
    r'#subform|form\d+subform|form1|root|body)',
    re.IGNORECASE
)
GENERIC_FIELD_RE = re.compile(
    r'^(checkbox\d+|checkBox\d+|yescheckbox\d*|nocheckbox\d*|'
    r'radioButton\d+|radioButtonList|textField\d+|textBox\d+|'
    r'field\d+|input\d+|text\d+|button\d+|group\d+|'
    r'untitled\d*|unknown\d*|newField\d*|default\d*)$',
    re.IGNORECASE
)

stats = {
    "schemas_processed": 0,
    "schemas_modified": 0,
    "dates_composed": 0,
    "fragments_removed": 0,
    "duplicates_removed": 0,
    "needs_redigitization": [],
    "xfa_field_count": 0,
    "generic_field_count": 0,
}


def compose_date_fragments(properties):
    """
    Find date fragment groups and compose them into single date fields.
    Returns (new_properties, changes_made) with fragments merged.
    """
    # Group fragments by base name
    date_groups = defaultdict(dict)
    non_date_fields = {}

    for name, defn in properties.items():
        m = DATE_FRAGMENT_RE.match(name)
        if m:
            base = m.group(1)
            part = m.group(2).lower()
            date_groups[base][part] = (name, defn)
        else:
            non_date_fields[name] = defn

    changes = 0
    composed = {}

    for base, parts in date_groups.items():
        if len(parts) >= 2:
            # Compose into a single date field
            composed[base] = {
                "type": "string",
                "format": "date"
            }
            changes += 1
            stats["dates_composed"] += 1
            stats["fragments_removed"] += len(parts)
        else:
            # Only one fragment — still fix it but keep as-is with corrected name
            for part, (orig_name, defn) in parts.items():
                # Single fragment, just keep the original
                non_date_fields[orig_name] = defn

    # Merge: non-date fields first, then composed dates (maintaining rough order)
    result = {}
    # Insert composed dates roughly where the first fragment was
    fragment_positions = {}
    original_keys = list(properties.keys())
    for base, parts in date_groups.items():
        if len(parts) >= 2:
            first_pos = len(original_keys)
            for part, (orig_name, defn) in parts.items():
                try:
                    pos = original_keys.index(orig_name)
                    first_pos = min(first_pos, pos)
                except ValueError:
                    pass
            fragment_positions[base] = first_pos

    # Rebuild in original order, substituting composed dates for first fragment
    inserted_bases = set()
    for i, key in enumerate(original_keys):
        m = DATE_FRAGMENT_RE.match(key)
        if m:
            base = m.group(1)
            if base in composed:
                if base not in inserted_bases:
                    result[base] = composed[base]
                    inserted_bases.add(base)
                # Skip all fragments (they've been composed)
                continue
            else:
                # Single fragment, keep original
                result[key] = properties[key]
        else:
            result[key] = properties[key]

    return result, changes


def remove_case_duplicates(properties):
    """Remove fields that are duplicates differing only in case."""
    seen = {}  # lowercase → (original_name, definition)
    to_remove = []

    for name, defn in properties.items():
        lower = name.lower()
        if lower in seen:
            # Prefer the version that's camelCase (more standard)
            existing_name = seen[lower][0]
            # Keep whichever has more info (description, etc.)
            existing_defn = seen[lower][1]
            existing_has_desc = isinstance(existing_defn, dict) and "description" in existing_defn
            new_has_desc = isinstance(defn, dict) and "description" in defn

            if new_has_desc and not existing_has_desc:
                to_remove.append(existing_name)
                seen[lower] = (name, defn)
            else:
                to_remove.append(name)
        else:
            seen[lower] = (name, defn)

    changes = 0
    new_props = {}
    for name, defn in properties.items():
        if name not in to_remove:
            new_props[name] = defn
        else:
            changes += 1
            stats["duplicates_removed"] += 1

    return new_props, changes


def count_quality_issues(properties, form_name):
    """Count XFA and generic names — these need redigitization, not post-processing."""
    xfa_count = 0
    generic_count = 0

    for name in properties.keys():
        if XFA_RAW_RE.match(name):
            xfa_count += 1
        elif GENERIC_FIELD_RE.match(name):
            generic_count += 1

    stats["xfa_field_count"] += xfa_count
    stats["generic_field_count"] += generic_count

    if xfa_count > 0 or generic_count > 0:
        stats["needs_redigitization"].append({
            "form": form_name,
            "xfa_fields": xfa_count,
            "generic_fields": generic_count,
            "total_bad": xfa_count + generic_count
        })


def update_metadata(schema, properties):
    """Recalculate metadata after changes."""
    meta = schema.get("x-va-metadata", {})

    # Count all fields including nested
    def count_fields(props):
        count = 0
        for name, defn in props.items():
            count += 1
            if isinstance(defn, dict) and "properties" in defn:
                count += count_fields(defn["properties"])
        return count

    total = count_fields(properties)
    meta["composedFields"] = total
    meta["postProcessedAt"] = datetime.now(timezone.utc).isoformat()

    # Check if there are still quality issues
    has_xfa = any(XFA_RAW_RE.match(n) for n in properties.keys())
    has_generic = any(GENERIC_FIELD_RE.match(n) for n in properties.keys())
    if has_xfa or has_generic:
        meta["needsReviewCount"] = sum(1 for n in properties.keys()
                                        if XFA_RAW_RE.match(n) or GENERIC_FIELD_RE.match(n))
        # Don't claim 100% if there are still issues
        if meta.get("coveragePercent", 0) == 100 and meta["needsReviewCount"] > 0:
            # Recalculate: good fields / total fields
            bad = meta["needsReviewCount"]
            if total > 0:
                meta["coveragePercent"] = round((total - bad) / total * 100)
    else:
        meta["needsReviewCount"] = 0

    schema["x-va-metadata"] = meta


def process_schema(filepath, dry_run=False):
    """Process a single schema file."""
    try:
        with open(filepath) as f:
            schema = json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        print(f"  ERROR: Cannot read {filepath}: {e}")
        return False

    form_name = schema.get("title", Path(filepath).stem)
    properties = schema.get("properties", {})

    if not properties:
        return False

    stats["schemas_processed"] += 1
    total_changes = 0

    # 1. Compose date fragments
    properties, date_changes = compose_date_fragments(properties)
    total_changes += date_changes

    # 2. Remove case duplicates
    properties, dupe_changes = remove_case_duplicates(properties)
    total_changes += dupe_changes

    # 3. Count issues that need redigitization (don't fix, just flag)
    count_quality_issues(properties, form_name)

    if total_changes > 0:
        stats["schemas_modified"] += 1
        schema["properties"] = properties

        # Update required array if any composed date base names need to replace fragments
        if "required" in schema:
            new_required = []
            for req in schema["required"]:
                m = DATE_FRAGMENT_RE.match(req)
                if m and m.group(1) in properties:
                    base = m.group(1)
                    if base not in new_required:
                        new_required.append(base)
                elif req in properties:
                    new_required.append(req)
            schema["required"] = new_required

        # Update metadata
        update_metadata(schema, properties)

        if dry_run:
            print(f"  [DRY RUN] Would modify {form_name}: {date_changes} dates composed, {dupe_changes} duplicates removed")
        else:
            with open(filepath, 'w') as f:
                json.dump(schema, f, indent=2)
            print(f"  FIXED {form_name}: {date_changes} dates composed, {dupe_changes} duplicates removed")

        return True
    return False


def update_index_files(dry_run=False):
    """Update index.json files to reflect post-processed schema changes."""
    if dry_run:
        return

    for root, dirs, files in os.walk(SCHEMAS_DIR):
        if "index.json" not in files:
            continue

        index_path = os.path.join(root, "index.json")
        try:
            with open(index_path) as f:
                index_data = json.load(f)
        except:
            continue

        # Handle both array and object format
        forms = index_data.get("forms", [])
        if isinstance(forms, dict):
            forms_list = list(forms.values())
        else:
            forms_list = forms

        modified = False
        for form_entry in forms_list:
            form_name = form_entry.get("name", "")
            # Find matching schema file
            schema_file = None
            for f in os.listdir(root):
                if f.endswith(".json") and f != "index.json":
                    try:
                        with open(os.path.join(root, f)) as sf:
                            s = json.load(sf)
                        if s.get("title") == form_name:
                            schema_file = os.path.join(root, f)
                            meta = s.get("x-va-metadata", {})
                            # Sync index entry with schema metadata
                            if "composedFields" in meta:
                                form_entry["composedFields"] = meta["composedFields"]
                            if "coveragePercent" in meta:
                                form_entry["coveragePercent"] = meta["coveragePercent"]
                            if "needsReviewCount" in meta:
                                form_entry["needsReviewCount"] = meta["needsReviewCount"]
                            modified = True
                            break
                    except:
                        continue

        if modified:
            with open(index_path, 'w') as f:
                json.dump(index_data, f, indent=2)
            print(f"  Updated index: {index_path}")


def main():
    parser = argparse.ArgumentParser(description="Post-process VA form schemas")
    parser.add_argument("--dry-run", action="store_true", help="Show what would change without modifying files")
    parser.add_argument("--form", type=str, help="Process only a specific form by name")
    args = parser.parse_args()

    print("=" * 70)
    print("VA Form Schema Post-Processor")
    print("=" * 70)
    if args.dry_run:
        print("[DRY RUN MODE — no files will be modified]")
    print()

    schema_files = []
    for root, dirs, files in os.walk(SCHEMAS_DIR):
        for f in sorted(files):
            if f.endswith(".json") and f != "index.json":
                schema_files.append(os.path.join(root, f))

    for filepath in schema_files:
        if args.form:
            try:
                with open(filepath) as f:
                    s = json.load(f)
                if s.get("title") != args.form:
                    continue
            except:
                continue

        process_schema(filepath, dry_run=args.dry_run)

    # Run field name fixer (label cleanup, concatenation splitting, etc.)
    if not args.dry_run:
        print("\n" + "=" * 70)
        print("Running field name fixer (fix-field-names.py)...")
        print("=" * 70)
        import subprocess
        fix_script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fix-field-names.py")
        fix_args = [sys.executable, fix_script]
        if args.form:
            fix_args += ["--form", args.form]
        result = subprocess.run(fix_args, capture_output=False)
        if result.returncode != 0:
            print(f"  WARNING: fix-field-names.py exited with code {result.returncode}")

    # Update index files
    if not args.dry_run:
        print("\nUpdating index.json files...")
        update_index_files(dry_run=args.dry_run)

    # Print summary
    print()
    print("=" * 70)
    print("POST-PROCESSING SUMMARY")
    print("=" * 70)
    print(f"Schemas processed:        {stats['schemas_processed']}")
    print(f"Schemas modified:         {stats['schemas_modified']}")
    print(f"Date fields composed:     {stats['dates_composed']} (from {stats['fragments_removed']} fragments)")
    print(f"Duplicates removed:       {stats['duplicates_removed']}")
    print()

    if stats["needs_redigitization"]:
        print("=" * 70)
        print(f"FORMS NEEDING REDIGITIZATION: {len(stats['needs_redigitization'])}")
        print("(Raw XFA or generic field names — requires PDF re-extraction)")
        print("=" * 70)

        # Sort by total bad fields
        redig = sorted(stats["needs_redigitization"], key=lambda x: -x["total_bad"])
        for entry in redig:
            print(f"  {entry['form']:35s}  XFA: {entry['xfa_fields']:3d}  Generic: {entry['generic_fields']:3d}")

        print(f"\n  Total fields needing redigitization: {stats['xfa_field_count']} XFA + {stats['generic_field_count']} generic = {stats['xfa_field_count'] + stats['generic_field_count']}")

        # Write redigitization list to file
        if not args.dry_run:
            redig_path = os.path.join(os.path.dirname(SCHEMAS_DIR), "redigitize-queue.json")
            with open(redig_path, 'w') as f:
                json.dump({
                    "generatedAt": datetime.now(timezone.utc).isoformat(),
                    "totalForms": len(redig),
                    "forms": redig
                }, f, indent=2)
            print(f"\n  Redigitization queue written to: redigitize-queue.json")


if __name__ == "__main__":
    main()
