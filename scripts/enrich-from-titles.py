#!/usr/bin/env python3
"""
Enrich all VA form schemas with x-va-form metadata.

Uses the va-form-titles.json lookup to add proper form titles,
and infers section structure from field naming patterns.

This script does NOT require internet access — it works from the
title lookup file and the existing schema data.

Usage: python3 scripts/enrich-from-titles.py [--dry-run] [--form FORM_NAME]
"""

import json
import os
import re
import sys
import argparse
from collections import OrderedDict

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
SCHEMAS_DIR = os.path.join(os.path.dirname(SCRIPTS_DIR), "schemas")
TITLES_FILE = os.path.join(SCRIPTS_DIR, "va-form-titles.json")

# Load title lookup
with open(TITLES_FILE) as f:
    TITLE_LOOKUP = json.load(f)

# Build case-insensitive lookup
TITLE_LOOKUP_LOWER = {k.lower(): v for k, v in TITLE_LOOKUP.items()}

# ─── Section inference from field name prefixes ───

SECTION_PATTERNS = OrderedDict([
    # Veteran info
    (r'^veteran', "Veteran's Information"),
    # Claimant info
    (r'^claimant', "Claimant's Information"),
    # Spouse
    (r'^spouse', "Spouse's Information"),
    # Dependent
    (r'^dependent', "Dependent Information"),
    # Service info
    (r'^(branchOf|dateEntered|dateLeft|placeLeft|serviceNumber|service)', "Service Information"),
    # Employer/employment
    (r'^(employer|employment|nameand|completeaddress|typeOfWork|grossamount|timeLost|concession|occupation)',
     "Employment Information"),
    # Mailing address
    (r'^mailing', "Mailing Address"),
    # Home address
    (r'^(home(?!Loan)|residential)', "Home Address"),
    # Insurance
    (r'^insurance', "Insurance Information"),
    # Nursing home
    (r'^(nursing|nameOfNursing)', "Nursing Home Information"),
    # Hospital
    (r'^hospital', "Hospital Information"),
    # Physician/doctor/medical
    (r'^(physician|doctor|medical|diagnosis|treatment|health|exam)', "Medical Information"),
    # Financial
    (r'^(income|asset|expense|financial|net\s*worth|monthly|annual|gross|rent|mortgage|bank|savings)',
     "Financial Information"),
    # Education
    (r'^(school|education|course|degree|training|college|university)', "Education Information"),
    # Property/housing
    (r'^(property|housing|dwelling|building|lot|land|construction|home\s*loan|loan)',
     "Property Information"),
    # Burial
    (r'^(burial|death|cemetery|funeral|remains|interment)', "Burial Information"),
    # Authorization/signature
    (r'^(signature|dateSigned|certif|authorization|agree|consent)', "Certification and Signature"),
])


def infer_sections(properties):
    """Group fields into sections based on name prefixes."""
    sections = OrderedDict()
    unmatched = []

    for field_name in properties.keys():
        matched = False
        for pattern, section_title in SECTION_PATTERNS.items():
            if re.match(pattern, field_name, re.IGNORECASE):
                if section_title not in sections:
                    sections[section_title] = []
                sections[section_title].append(field_name)
                matched = True
                break
        if not matched:
            unmatched.append(field_name)

    # Only return sections if we found meaningful groupings
    result = []
    for title, field_ids in sections.items():
        if len(field_ids) >= 2:  # Need at least 2 fields to make a section worthwhile
            result.append({
                "title": title,
                "rows": [{"columns": [{"fieldId": fid, "width": 12}]} for fid in field_ids]
            })
        else:
            unmatched.extend(field_ids)

    # Remaining fields
    if unmatched:
        result.append({
            "title": "Additional Information",
            "rows": [{"columns": [{"fieldId": fid, "width": 12}]} for fid in unmatched]
        })

    return result if len(result) > 1 else []  # Only return if multiple sections found


def get_form_title(form_number):
    """Look up the official title for a form number."""
    # Direct match
    if form_number in TITLE_LOOKUP:
        return TITLE_LOOKUP[form_number]
    # Case-insensitive match
    if form_number.lower() in TITLE_LOOKUP_LOWER:
        return TITLE_LOOKUP_LOWER[form_number.lower()]
    # Try without trailing letters
    base = re.sub(r'[a-z]$', '', form_number)
    if base in TITLE_LOOKUP:
        return TITLE_LOOKUP[base]
    if base.lower() in TITLE_LOOKUP_LOWER:
        return TITLE_LOOKUP_LOWER[base.lower()]
    return None


def infer_title_from_fields(properties):
    """Try to infer form purpose from field names."""
    field_names = [k.lower() for k in properties.keys()]
    all_text = ' '.join(field_names)

    if any(w in all_text for w in ['burial', 'funeral', 'death', 'interment']):
        return 'Burial Benefits Application'
    if any(w in all_text for w in ['education', 'school', 'training', 'course']):
        return 'Education Benefits Form'
    if any(w in all_text for w in ['disability', 'compensation', 'claim']):
        return 'Disability Compensation Form'
    if any(w in all_text for w in ['pension', 'income', 'networth']):
        return 'Pension Benefits Form'
    if any(w in all_text for w in ['loan', 'mortgage', 'property', 'housing']):
        return 'Home Loan Form'
    if any(w in all_text for w in ['insurance', 'policy', 'premium']):
        return 'Insurance Form'
    if any(w in all_text for w in ['employment', 'employer', 'occupation']):
        return 'Employment Information Form'
    if any(w in all_text for w in ['medical', 'health', 'treatment', 'physician']):
        return 'Medical Information Form'
    if any(w in all_text for w in ['fiduciary', 'guardian', 'custodian']):
        return 'Fiduciary Form'
    if any(w in all_text for w in ['dependent', 'spouse', 'child']):
        return 'Dependents Form'

    return None


# ─── BIO Form Section Mappings ───
BIO_SECTIONS = {
    '21-0779': {
        'formTitle': 'Request for Nursing Home Information in Connection with Claim for Aid and Attendance',
        'sections': [
            {"title": "Section I: Veteran's Identification Information",
             "prefixes": ['veteran', 'vaFileNumber', 'dateOfBirth', 'socialSecurity']},
            {"title": "Section II: Claimant's Identification Information",
             "prefixes": ['claimant']},
            {"title": "Section III: Nursing Home Information",
             "prefixes": ['nursing', 'addressOf', 'nameOfNursing', 'city', 'state', 'zip', 'country', 'apartment']},
            {"title": "Section IV: General Information",
             "prefixes": ['dateOf', 'medicaid', 'monthly', 'certification', 'levelOfCare', 'nursingOfficial']},
        ]
    },
    '21-2680': {
        'formTitle': 'Examination for Housebound Status or Permanent Need for Regular Aid and Attendance',
        'sections': [
            {"title": "Section I: Veteran's Identification Information",
             "prefixes": ['veteran', 'vaFileNumber', 'lastName', 'middleInitial1']},
            {"title": "Section II: Claimant's Identification Information",
             "prefixes": ['claimant', 'mailingAddress', 'telephoneNumber', 'telephone',
                          'emailAddress', 'internationalTelephone']},
            {"title": "Section III: Claim Information",
             "prefixes": ['benefit', 'typeOf']},
            {"title": "Section IV: Hospitalization Status",
             "prefixes": ['hospital', 'admission', 'currently', 'nameOfHospital', 'addressOfHospital']},
            {"title": "Section V: Physical Examination",
             "prefixes": ['completeDiagnosis', 'disability', 'age', 'weight', 'height',
                          'nutrition', 'gait', 'blood', 'pulse', 'respiratory',
                          'whatDisabilit', 'hoursInBed', 'bathing', 'toileting',
                          'transferring', 'feeding', 'additionalActivity', 'medication',
                          'tending', 'ambulat', 'dressing', 'leftEye', 'rightEye',
                          'additionalActivities', 'explain', 'describe']},
            {"title": "Section VI: Examiner's Certification",
             "prefixes": ['signature', 'dateSigned', 'certif', 'physician', 'examiner',
                          'dateOfExam', 'nameOf', 'digital', 'nationalProvider',
                          'assress', 'address']},
        ]
    },
    '21-4192': {
        'formTitle': 'Request for Employment Information in Connection with Claim for Disability Benefits',
        'sections': [
            {"title": "Section I: Veteran's Identification",
             "prefixes": ['veteran', 'lastName', 'middleInitial', 'socialSecurity', 'vaFile']},
            {"title": "Section II: Employment Information",
             "prefixes": ['employer', 'nameand', 'completeaddress', 'typeOf', 'dateOf',
                          'grossamount', 'timeLost', 'concession']},
            {"title": "Section III: Current Employment Status",
             "prefixes": ['reason', 'current', 'thousands', 'hundreds', 'tens', 'units', 'cents']},
            {"title": "Section IV: Certification",
             "prefixes": ['signature', 'dateSigned', 'certif', 'title', 'telephone']},
        ]
    },
    '21P-530a': {
        'formTitle': 'Application for Burial Benefits',
        'sections': [
            {"title": "Section I: Veteran Information",
             "prefixes": ['fullName', 'ssn', 'dateOfBirth', 'vaFile', 'serviceNumber']},
            {"title": "Section II: Claimant Information",
             "prefixes": ['address', 'phoneNumber', 'claimant', 'relationship']},
            {"title": "Section III: Burial and Service Information",
             "prefixes": ['dateOfBurial', 'dateOfDeath', 'dateEntered', 'dateLeft',
                          'placeLeft', 'branch', 'burial', 'cemetery', 'funeral']},
            {"title": "Section IV: Certification",
             "prefixes": ['dateSigned', 'signature']},
        ]
    }
}


def build_bio_sections(form_number, properties):
    """Build sections for BIO reference forms using manual prefix mapping."""
    config = BIO_SECTIONS.get(form_number)
    if not config:
        return None, None

    field_keys = list(properties.keys())
    used = set()
    sections = []

    for sec_def in config['sections']:
        field_ids = []
        for prefix in sec_def['prefixes']:
            for key in field_keys:
                if key not in used and key.lower().startswith(prefix.lower()):
                    field_ids.append(key)
                    used.add(key)
        if field_ids:
            sections.append({
                "title": sec_def['title'],
                "rows": [{"columns": [{"fieldId": fid, "width": 12}]} for fid in field_ids]
            })

    # Remaining
    remaining = [k for k in field_keys if k not in used]
    if remaining:
        sections.append({
            "title": "Additional Information",
            "rows": [{"columns": [{"fieldId": fid, "width": 12}]} for fid in remaining]
        })

    return config['formTitle'], sections


def process_schema(filepath, dry_run=False):
    """Process a single schema file."""
    try:
        with open(filepath) as f:
            schema = json.load(f)
    except Exception as e:
        print(f"  ERROR reading {filepath}: {e}")
        return False

    form_number = schema.get('title', os.path.basename(filepath).replace('.json', ''))
    properties = schema.get('properties', {})
    if not properties:
        return False

    # Check if already enriched with meaningful data
    existing = schema.get('x-va-form', {})
    if existing.get('formTitle') and existing.get('formSections'):
        return False  # Already enriched

    # Build x-va-form
    va_form = {}
    va_form['formNumber'] = form_number

    # Title: BIO forms first, then lookup, then inference
    bio_title, bio_sections = build_bio_sections(form_number, properties)

    if bio_title:
        va_form['formTitle'] = bio_title
    else:
        title = get_form_title(form_number)
        if not title:
            title = infer_title_from_fields(properties)
        if title:
            va_form['formTitle'] = title
        else:
            va_form['formTitle'] = f"VA Form {form_number}"

    # Sections: BIO forms get manual sections, others get inferred
    if bio_sections:
        va_form['formSections'] = bio_sections
    else:
        inferred = infer_sections(properties)
        if inferred:
            va_form['formSections'] = inferred

    # Copy over any existing OMB/burden data
    if existing.get('ombNumber'):
        va_form['ombNumber'] = existing['ombNumber']
    if existing.get('respondentBurden'):
        va_form['respondentBurden'] = existing['respondentBurden']
    if existing.get('instructions'):
        va_form['instructions'] = existing['instructions']

    if dry_run:
        sections_count = len(va_form.get('formSections', []))
        print(f"  [DRY RUN] {form_number}: \"{va_form['formTitle']}\" ({sections_count} sections)")
        return True

    schema['x-va-form'] = va_form
    with open(filepath, 'w') as f:
        json.dump(schema, f, indent=2)

    sections_count = len(va_form.get('formSections', []))
    print(f"  ENRICHED {form_number}: \"{va_form['formTitle']}\" ({sections_count} sections)")
    return True


def main():
    parser = argparse.ArgumentParser(description="Enrich VA form schemas with titles and sections")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--form", type=str, help="Process only this form")
    args = parser.parse_args()

    print("=" * 70)
    print("VA Form Schema Enrichment (from title lookup)")
    print("=" * 70)
    if args.dry_run:
        print("[DRY RUN MODE]")
    print()

    schema_files = []
    for root, dirs, files in os.walk(SCHEMAS_DIR):
        for f in sorted(files):
            if f.endswith('.json') and f != 'index.json':
                schema_files.append(os.path.join(root, f))

    processed = 0
    enriched = 0
    with_title = 0
    with_sections = 0

    for filepath in schema_files:
        form_name = os.path.basename(filepath).replace('.json', '')
        if args.form and form_name != args.form:
            continue

        processed += 1
        if process_schema(filepath, dry_run=args.dry_run):
            enriched += 1
            # Check what we added
            try:
                with open(filepath) as f:
                    s = json.load(f)
                va = s.get('x-va-form', {})
                if va.get('formTitle') and va['formTitle'] != f"VA Form {form_name}":
                    with_title += 1
                if va.get('formSections'):
                    with_sections += 1
            except:
                pass

    print()
    print("=" * 70)
    print("ENRICHMENT SUMMARY")
    print("=" * 70)
    print(f"Schemas processed:       {processed}")
    print(f"Schemas enriched:        {enriched}")
    print(f"With known title:        {with_title}")
    print(f"With inferred sections:  {with_sections}")
    print(f"Title lookup entries:    {len(TITLE_LOOKUP)}")


if __name__ == "__main__":
    main()
