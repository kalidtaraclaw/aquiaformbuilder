#!/usr/bin/env python3
"""
Field Name Fixer — Cleans up raw XFA, generic, and verbose field names in schemas.

Handles:
1. XFA path remnants: form1SubformCheckBox21 → null (unsalvageable)
2. Underscore-delimited XFA: field_form1_0___subform_0__FacilityNo___0_ → facilityNo
3. Concatenated XFA: vha100143newform0subform1textfield10 → null
4. Structural table refs: #subformTable1Row1Cell2 → null
5. Bare type prefixes: checkboxDeath → death, checkBoxMarriageEnded → marriageEnded
6. Verbose split fields: socialSecurityNumberFirstThreeNumbers → compose into socialSecurityNumber
7. Non-user fields: respondentBurden, privacyActNotice → removed
8. Fix x-va-field labels to be human-readable

Run: python3 scripts/fix-field-names.py [--dry-run] [--form FORM_NAME]
"""

import json
import os
import re
import sys
import argparse
from collections import defaultdict, OrderedDict
from pathlib import Path
from datetime import datetime, timezone

SCHEMAS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "schemas")

# ─── Patterns ───

# XFA structural segments (these have no semantic meaning)
XFA_STRUCTURAL = re.compile(
    r'(topmostsubform|#subform|form\d+|subform\d*|page\d+|table\d+|row\d+|cell\d+|'
    r'root|body|newform\d*)',
    re.IGNORECASE
)

# Underscore-delimited XFA path: field_form1_0___subform_0__SomethingUseful___0_
UNDERSCORE_XFA_RE = re.compile(r'^field_.*__(.+?)(?:___\d+_)?$', re.IGNORECASE)

# Concatenated form prefixes: vba215350subform9textfield10, vha100143newform0subform1textfield10
CONCAT_XFA_RE = re.compile(
    r'^(?:vba|vha|nca|va)\d*.*?(?:subform|newform)\d*.*?(?:textfield|checkbox|radiobutton)\d+$',
    re.IGNORECASE
)

# Generic field names that are unsalvageable
GENERIC_RE = re.compile(
    r'^(checkbox\d+[a-z]?|checkBox\d+[a-z]?|yescheckbox\d*|nocheckbox\w*|'
    r'radioButton\d+|radioButtonList\d*|'
    r'textField\d+|textBox\d+|field\d+|input\d+|text\d+|button\d+|'
    r'group\d+|untitled\d*|unknown\d*|newField\d*|default\d*|'
    r's\d+subform\d+button\d+)$',  # e.g. s1047900subform0button10
    re.IGNORECASE
)

# Bare type prefixes to strip: checkboxDeath → death, checkBoxMarriageEnded → marriageEnded
TYPE_PREFIX_RE = re.compile(
    r'^(checkbox|checkBox|radioButton|textField|textBox|field|input)((?=[A-Z])[A-Za-z]+.*)$'
)

# Verbose split field patterns — match camelCase directly (no spaces needed)
SSN_PARTS_RE = re.compile(
    r'^(.*?(?:[Ss]ocial[Ss]ecurity[Nn]umber|[Ss]sn))'
    r'(?:[Ff]irst[Tt]hree|[Ss]econd[Tt]wo|[Ll]ast[Ff]our)'
    r'(?:[Nn]umbers?)?\d*$'
)
ZIP_PARTS_RE = re.compile(
    r'^(.*?(?:[Zz]ip(?:[Oo]r[Pp]ostal[Cc]ode)?|[Pp]ostal[Cc]ode))'
    r'(?:[Ff]irst[Ff]ive|[Ll]ast[Ff]our|[Ll]ast[Ff]ive)'
    r'(?:[Nn]umbers?)?\d*$'
)
PHONE_PARTS_RE = re.compile(
    r'^(.*?(?:[Tt]elephone|[Pp]hone)(?:[Nn]umber)?)'
    r'(?:[Ff]irst[Tt]hree|[Mm]iddle[Tt]hree|[Ll]ast[Ff]our|[Aa]rea[Cc]ode)'
    r'(?:[Nn]umbers?)?\d*$'
)

# Standalone SSN parts without "ssn" or "socialSecurityNumber" in the name
# e.g., "firstThreeNumbers", "secondTwoNumbersSpouse", "lastFourNumbers2"
STANDALONE_SSN_PARTS_RE = re.compile(
    r'^(.*?)(?:firstThreeNumbers|secondTwoNumbers|lastFourNumbers)'
    r'(.*?)(\d*)$',
    re.IGNORECASE
)

# Non-user-facing fields to remove
NON_USER_FIELDS = {
    'respondentburden', 'privacyactnotice', 'instructions', 'note',
    'paperworkreductionactnotice', 'ombcontrolnumber', 'ombapproval',
    'penaltiesstatement', 'expirationdate', 'respondentburdennotice',
    'formtitle', 'formsubtitle', 'formnumber', 'vaformtitle',
    'vaformnumber', 'pageof', 'pageofpages', 'supersedes',
    'existingstocksofvaform', 'prescribedbyva', 'resetform',
    'printform', 'saveform',
    'privacyactinformation', 'privacyactstatement', 'penaltystatement', 'penalty',
    'importantinformation', 'importantnotice',
}

# XFA array indices
XFA_INDEX_RE = re.compile(r'\[\d+\]')

stats = {
    "schemas_processed": 0,
    "schemas_modified": 0,
    "fields_renamed": 0,
    "fields_removed": 0,
    "fields_composed": 0,
    "xfa_stripped": 0,
    "type_prefixes_stripped": 0,
    "non_user_removed": 0,
    "labels_fixed": 0,
}


def to_camel_case(s):
    """Convert a string to camelCase."""
    # Split on non-alphanumeric, uppercase boundaries, and underscores
    s = re.sub(r'([a-z])([A-Z])', r'\1 \2', s)
    words = re.split(r'[^a-zA-Z0-9]+', s)
    words = [w for w in words if w]
    if not words:
        return ''
    return words[0].lower() + ''.join(w.capitalize() for w in words[1:])


def extract_semantic_name_from_xfa(raw_name):
    """
    Try to extract a meaningful name from an XFA-style field name.
    Returns the semantic part or None if unsalvageable.
    """
    name = raw_name

    # Strip XFA array indices: [0], [1], etc.
    name = XFA_INDEX_RE.sub('', name)

    # Handle underscore-delimited XFA paths: field_form1_0___subform_0__FacilityNo___0_
    m = UNDERSCORE_XFA_RE.match(name)
    if m:
        candidate = m.group(1).strip('_')
        # Remove any remaining structural parts
        candidate = re.sub(r'(?:subform|form)\d*_?', '', candidate, flags=re.IGNORECASE).strip('_')
        if candidate and len(candidate) > 2 and not GENERIC_RE.match(candidate):
            return to_camel_case(candidate)
        return None

    # Handle dot-separated XFA paths
    if '.' in name:
        segments = name.split('.')
        # Walk backwards to find a non-structural segment
        for seg in reversed(segments):
            seg = seg.strip()
            if not seg:
                continue
            if XFA_STRUCTURAL.match(seg):
                continue
            if GENERIC_RE.match(seg):
                continue
            if re.match(r'^(Page|Subform|Table|Row|Cell)\d*$', seg, re.IGNORECASE):
                continue
            return to_camel_case(seg)
        return None

    # Handle concatenated XFA: form1SubformCheckBox21
    if CONCAT_XFA_RE.match(name):
        return None

    # Strip ALL XFA structural segments from anywhere in the name
    # e.g., "dateForm10Subform0EffectiveDatePrimaryInsurance0" → "dateEffectiveDatePrimaryInsurance"
    # e.g., "form1SubformVeteransFirstName" → "VeteransFirstName"
    # e.g., "topmostSubformPage1checkBox1" → "checkBox1"
    # e.g., "1form10subform0textfield20" → "textfield20"
    cleaned = name

    # Strip leading digits
    cleaned = re.sub(r'^\d+', '', cleaned)
    # Strip leading single char + structural prefix (fSubform..., fPage1...)
    m = re.match(r'^[a-zA-Z](?=[Ss]ubform|[Pp]age\d|[Tt]able\d)', cleaned)
    if m:
        cleaned = cleaned[1:]
    # Strip vAform prefix (e.g., vAform1551checkBox)
    cleaned = re.sub(r'^v[Aa]form\d+', '', cleaned, count=1)
    # Strip fPage_ prefix (e.g., fPage_1Field47, fPage_2CheckBox1)
    cleaned = re.sub(r'^[Pp]age_?\d+', '', cleaned)

    # Iteratively strip XFA structural prefixes and embedded segments
    changed = True
    while changed:
        changed = False
        # Strip leading form prefix: form1, form10, Form10, etc.
        m = re.match(r'^[Ff]orm\d*(.*)', cleaned)
        if m and m.group(1):
            cleaned = m.group(1)
            changed = True
        # Strip leading subform prefix
        m = re.match(r'^[#]?[Ss]ubform\d*(.*)', cleaned)
        if m and m.group(1):
            cleaned = m.group(1)
            changed = True
        # Strip leading page prefix
        m = re.match(r'^[Pp]age\d*(.*)', cleaned)
        if m and m.group(1):
            cleaned = m.group(1)
            changed = True
        # Strip leading topmostSubform
        m = re.match(r'^topmostSubform(.*)', cleaned, re.IGNORECASE)
        if m and m.group(1):
            cleaned = m.group(1)
            changed = True
        # Strip embedded form/subform segments: "dateForm10Subform0Effective..." → "dateEffective..."
        new_cleaned = re.sub(r'[Ff]orm\d*[Ss]ubform\d*(?:[Ss]ubform\d*)*', '', cleaned)
        if new_cleaned != cleaned and new_cleaned:
            cleaned = new_cleaned
            changed = True
        # Strip standalone embedded Subform segments
        new_cleaned = re.sub(r'[Ss]ubform\d*', '', cleaned)
        if new_cleaned != cleaned and new_cleaned:
            cleaned = new_cleaned
            changed = True
        # Strip table/row/header structural segments
        new_cleaned = re.sub(r'[Tt]able\d*(?:[Hh]eader)?[Rr]ow\d*', '', cleaned)
        if new_cleaned != cleaned and new_cleaned:
            cleaned = new_cleaned
            changed = True
        # Strip leading underscores/dots/hashes/trailing digits at boundaries
        new_cleaned = cleaned.lstrip('_.#')
        if new_cleaned != cleaned:
            cleaned = new_cleaned
            changed = True
        # Strip trailing 0 that's an index remnant (but not meaningful numbers)
        new_cleaned = re.sub(r'(\D)0$', r'\1', cleaned)
        if new_cleaned != cleaned:
            cleaned = new_cleaned
            changed = True

    if not cleaned or len(cleaned) < 3:
        return None

    # After stripping XFA prefixes, check if what's left is generic
    if GENERIC_RE.match(cleaned):
        return None

    return cleaned  # Will be further processed by the caller


def strip_type_prefix(name):
    """
    Strip bare type prefixes: checkboxDeath → death, checkBoxMarriageEnded → marriageEnded
    """
    m = TYPE_PREFIX_RE.match(name)
    if m:
        semantic = m.group(2)
        # Make sure the remaining part is meaningful
        if len(semantic) > 2:
            # Lowercase the first char
            return semantic[0].lower() + semantic[1:]
    return name


def clean_verbose_name(name):
    """
    Clean up overly verbose field names.
    e.g., "checkBoxByCheckingTheBoxICertifyThat..." → simplify
    """
    # These mega-verbose checkbox names should just be simplified
    if len(name) > 80:
        # Try to extract the key concept
        # "iAuthorizeVaToDiscloseAllMyRecords..." → "authorizeVaDisclosure"
        # Just truncate and clean for now
        return None  # Mark for removal — these should be text-inferred

    return name


def humanize_label(name):
    """
    Convert a camelCase property key to a human-readable label.
    "veteranFirstName" → "Veteran's First Name"
    "socialSecurityNumber" → "Social Security Number"
    "dateOfBirth" → "Date of Birth"
    Also handles all-lowercase concatenated names: "namevet" → "Name Vet"
    """
    # Replace underscores with spaces early
    base = name.replace('_', ' ')
    # Strip trailing digits used for uniqueness (childsLastName2 → childsLastName)
    base = re.sub(r'\d+$', '', base).strip()
    if not base:
        base = name.replace('_', ' ')

    # Handle trailing single-letter suffixes on known date/time words
    # datea → Date A, montha → Month A, yeara → Year A, daya → Day A
    base_lower = base.lower().strip()
    for time_word in ['date', 'month', 'year', 'day']:
        if base_lower.startswith(time_word) and len(base_lower) == len(time_word) + 1:
            suffix_char = base_lower[-1]
            if suffix_char.isalpha():
                return time_word.capitalize() + ' ' + suffix_char.upper()

    # Insert spaces around digits that separate words (e.g., "Employee2JobTitle" → "Employee 2 Job Title")
    # But preserve digits at the end of labels (e.g., "amount31a" stays)
    # Pattern: letter followed by digit(s) followed by letter (mid-word digit separator)
    base = re.sub(r'([a-zA-Z])(\d+)([a-zA-Z])', r'\1 \2 \3', base)

    # Split on camelCase boundaries
    label = re.sub(r'([a-z])([A-Z])', r'\1 \2', base)
    label = re.sub(r'([A-Z]+)([A-Z][a-z])', r'\1 \2', label)

    # Strip trailing underscores/spaces and clean up multiple spaces
    label = re.sub(r'[\s_]+$', '', label)
    label = re.sub(r'\s+', ' ', label).strip()

    # If the result is still a single word (no camelCase boundaries found),
    # try dictionary-based splitting for all-lowercase concatenated names
    if ' ' not in label and len(label) >= 6:
        split_result = split_concatenated_label(label.capitalize())
        if split_result:
            label = split_result

    # Fix common word-boundary issues
    label = re.sub(r'\bDeathof\b', 'Death of', label, flags=re.IGNORECASE)
    label = re.sub(r'\bNameof\b', 'Name of', label, flags=re.IGNORECASE)
    label = re.sub(r'\bTypeof\b', 'Type of', label, flags=re.IGNORECASE)
    label = re.sub(r'\bNumberof\b', 'Number of', label, flags=re.IGNORECASE)
    label = re.sub(r'\bDateof\b', 'Date of', label, flags=re.IGNORECASE)
    label = re.sub(r'\bAmember\b', 'a Member', label, flags=re.IGNORECASE)
    label = re.sub(r'\bZipor\b', 'ZIP or', label, flags=re.IGNORECASE)
    label = re.sub(r'\bZiporPostal\b', 'ZIP or Postal', label, flags=re.IGNORECASE)
    label = re.sub(r'\bEMail\b', 'Email', label, flags=re.IGNORECASE)
    label = re.sub(r'\bE Mail\b', 'Email', label, flags=re.IGNORECASE)
    label = re.sub(r'\bChilds\b', "Child's", label)
    label = re.sub(r'\bVeterans\b', "Veteran's", label)
    label = re.sub(r'\bClaimants\b', "Claimant's", label)
    # Fix concatenated words that survive camelCase splitting
    label = re.sub(r'\bVafile\b', 'VA File', label, flags=re.IGNORECASE)
    label = re.sub(r'\bServicenumber\b', 'Service Number', label, flags=re.IGNORECASE)
    label = re.sub(r'\bDobspouse\b', 'DOB Spouse', label, flags=re.IGNORECASE)
    label = re.sub(r'\bDob\b', 'DOB', label)
    label = re.sub(r'\bFilenumber\b', 'File Number', label, flags=re.IGNORECASE)
    label = re.sub(r'\bFilenum\b', 'File Number', label, flags=re.IGNORECASE)
    label = re.sub(r'\bVafilenumber\b', 'VA File Number', label, flags=re.IGNORECASE)
    label = re.sub(r'\bTelephonenumber\b', 'Telephone Number', label, flags=re.IGNORECASE)
    label = re.sub(r'\bPhonenumber\b', 'Phone Number', label, flags=re.IGNORECASE)
    label = re.sub(r'\bEmailaddress\b', 'Email Address', label, flags=re.IGNORECASE)
    label = re.sub(r'\bMailingaddress\b', 'Mailing Address', label, flags=re.IGNORECASE)
    label = re.sub(r'\bDollaramount\b', 'Dollar Amount', label, flags=re.IGNORECASE)
    label = re.sub(r'\bBaggagefees\b', 'Baggage Fees', label, flags=re.IGNORECASE)
    # Fix abbreviated words (case-insensitive for dictionary-split lowercase results)
    label = re.sub(r'\bNum\b', 'Number', label, flags=re.IGNORECASE)
    label = re.sub(r'\bAcct\b', 'Account', label, flags=re.IGNORECASE)
    label = re.sub(r'\bInst\b', 'Institution', label, flags=re.IGNORECASE)
    label = re.sub(r'\bCert\b', 'Certifying', label, flags=re.IGNORECASE)
    label = re.sub(r'\bComp\b', 'Compensation', label, flags=re.IGNORECASE)
    label = re.sub(r'\bVet\b', 'Veteran', label, flags=re.IGNORECASE)

    # Capitalize first letter of each word
    words = label.split()
    # Common lowercase words (not at start)
    lowered = {'of', 'the', 'and', 'or', 'in', 'to', 'for', 'a', 'an', 'by', 'on', 'at', 'is', 'no'}
    # Acronyms to always uppercase
    acronyms = {'va', 'ssn', 'zip', 'id', 'us', 'dob', 'pow', 'ptsd', 'omb', 'po', 'mi', 'dic', 'ein',
                 'dmo', 'vamc', 'visn', 'rd'}

    result = []
    for i, w in enumerate(words):
        wl = w.lower()
        if wl in acronyms:
            result.append(w.upper())
        elif i == 0:
            result.append(w[0].upper() + w[1:] if w else '')
        elif wl in lowered:
            result.append(wl)
        else:
            result.append(w[0].upper() + w[1:] if w else '')
    return ' '.join(result)


# ─── Dictionary word splitter for concatenated lowercase labels ───

# Words that should NEVER be split (common English words that contain substrings of other words)
DONT_SPLIT = {
    'together', 'statement', 'international', 'relationship', 'information',
    'certification', 'organization', 'authorization', 'determination',
    'approximately', 'communication', 'circumstances', 'documentation',
    'investigation', 'acknowledging', 'consideration', 'establishment',
    'representative', 'administration', 'transportation', 'understanding',
    'responsibility', 'classification', 'identification', 'recommendation',
    'acknowledgment', 'accommodation', 'rehabilitation', 'correspondence',
    'participation', 'notification', 'hospitalization', 'discrimination',
    'representation', 'memorandum', 'telephone', 'beginning', 'education',
    'employment', 'department', 'treatment', 'description', 'additional',
    'maintenance', 'certificate', 'beneficiary', 'relationship', 'signature',
    'institution', 'occupation', 'application', 'compensation', 'appointment',
    'separation', 'permission', 'information', 'instruction', 'disability',
    'deductions', 'dependents', 'residence', 'insurance', 'secondary',
    'allowance', 'condition', 'discharge', 'diagnosis', 'physician',
    'claimant', 'training', 'coverage', 'military', 'marriage',
    'province', 'building', 'guardian', 'personal', 'business',
    'position', 'relative', 'children', 'previous', 'specific',
    'location', 'facility', 'hospital', 'divorced', 'interest',
    'deceased', 'complete', 'continue', 'remarked', 'departure',
    'formerly', 'category', 'widowed', 'deposits', 'balance',
    'payment', 'pension', 'premium', 'purpose', 'reserve',
    'country', 'account', 'address', 'service', 'veteran',
    'current', 'general', 'special', 'college', 'expense',
    'charges', 'savings', 'witness', 'offices', 'medical',
    'receipt', 'benefit', 'related', 'company', 'release',
    'defined', 'arrival', 'monthly', 'expenditures', 'expenditure',
    # Construction terms that should NOT be split
    'insulation', 'foundation', 'foundations', 'reinforcing', 'prefabricated',
    'miscellaneous', 'accessories', 'decorating', 'excavation', 'countertop',
    'waterproofing', 'underlayment', 'conditioning', 'galvanized', 'aluminum',
    'electrical', 'sheathing', 'fireplace', 'fireplaces', 'downspouts',
    'bridging', 'doorbell', 'plumbing', 'planting', 'capacity',
    'shingles', 'exposure', 'membrane', 'diagonal', 'observer',
}

# VA form term dictionary for splitting concatenated labels.
# Ordered longest-first within each group to enable greedy matching.
VA_WORD_LIST = sorted(set([
    # Atomic words only — no compound terms (let the splitter combine them)
    'veteran', 'spouse', 'claimant', 'dependent', 'beneficiary',
    'applicant', 'patient', 'guardian', 'fiduciary', 'custodian',
    'address', 'street', 'city', 'state', 'county', 'country',
    'province', 'apartment', 'unit', 'building', 'floor', 'suite',
    'name', 'first', 'middle', 'last', 'initial', 'suffix', 'prefix',
    'number', 'phone', 'telephone', 'fax', 'email', 'cell', 'mobile',
    'date', 'dates', 'month', 'day', 'year', 'from', 'through', 'ending',
    'beginning', 'birth', 'death', 'marriage', 'divorce', 'separation',
    'total', 'amount', 'balance', 'value', 'rate', 'cost', 'fee', 'payment',
    'income', 'receipts', 'receipt', 'expenses', 'expense',
    'charges', 'charge', 'deductions', 'deposits', 'deposit',
    'expenditures', 'expenditure',
    'checking', 'saving', 'savings', 'account', 'acct', 'bond', 'security',
    'insurance', 'premium', 'policy', 'coverage', 'benefit', 'pension',
    'compensation', 'allowance', 'allocation', 'escrowed', 'escrow',
    'service', 'military', 'rank', 'rating', 'grade', 'branch',
    'active', 'duty', 'reserve', 'guard', 'discharge', 'release',
    'admission', 'transfer', 'treatment', 'diagnosis', 'condition',
    'disability', 'medical', 'hospital', 'facility', 'clinic', 'physician',
    'employer', 'employee', 'employment', 'occupation', 'position',
    'salary', 'wages', 'earnings', 'gross', 'net', 'highest', 'lowest',
    'education', 'school', 'college', 'university', 'degree', 'training',
    'type', 'kind', 'category', 'status', 'reason', 'purpose', 'remarks',
    'description', 'information', 'instructions', 'certification',
    'signature', 'witness', 'official', 'authority', 'title',
    'relationship', 'relative', 'family', 'child', 'children',
    'mailing', 'current', 'previous', 'former', 'primary', 'secondary',
    'other', 'additional', 'general', 'special', 'specific',
    'organization', 'institution', 'company', 'agency', 'office',
    'departure', 'arrival', 'point', 'location', 'place',
    'whom', 'how', 'why', 'when', 'where', 'which', 'what',
    'not', 'and', 'the', 'for', 'per', 'with', 'this',
    'personal', 'home', 'work',
    'separated', 'married', 'single', 'widowed', 'divorced',
    'face', 'interest', 'cash', 'market',
    'train', 'cert', 'inst', 'num', 'vet',
    'dob', 'ssn', 'zip', 'file', 'act', 'va', 'id',
    # Additional terms found in VA form concatenated labels
    'social', 'mailing', 'postal', 'code', 'area',
    'issue', 'issues', 'loan', 'requested', 'attended',
    'conducted', 'review', 'accommodation', 'accommodations',
    'implemented', 'appropriation', 'environmental',
    'investigator', 'investigators', 'identification',
    'paid', 'pay', 'by', 'if', 'of', 'or', 'in', 'to', 'on', 'at', 'is',
    'was', 'has', 'had', 'are', 'been', 'were', 'did', 'does',
    'no', 'yes', 'age', 'sex', 'race',
    'entered', 'ended', 'began', 'start', 'stop', 'end',
    'claim', 'claims', 'award', 'effective',
    'action', 'request', 'requested',
    'notice', 'certified', 'approved', 'denied', 'pending',
    'rehabilitation', 'authorization', 'transportation',
    'representative', 'establishment', 'international',
    'department', 'appropriation', 'applicants',
    'program', 'plan', 'loan', 'property', 'real', 'estate',
    'percentage', 'percent', 'monthly', 'annual', 'weekly', 'daily',
    'source', 'sources', 'item', 'items', 'list', 'noted',
    'full', 'part', 'time', 'completed', 'incomplete',
    'signed', 'printed', 'typed', 'read', 'above', 'below',
    'section', 'part', 'page', 'form', 'field', 'box', 'block',
    'required', 'optional', 'applicable', 'applicable',
    'base', 'basic', 'standard', 'maximum', 'minimum',
    'new', 'old', 'prior', 'after', 'before',
    'same', 'each', 'every', 'any', 'all', 'own',
    'given', 'known', 'called', 'named', 'made', 'done',
    'under', 'over', 'between', 'within', 'during', 'since',
    'also', 'still', 'currently', 'previously', 'formerly',
    'only', 'just', 'exactly', 'about', 'around',
    'than', 'then', 'that', 'those', 'these', 'there', 'here',
    'who', 'whose', 'whom',
    'his', 'her', 'its', 'your', 'their', 'our', 'my',
    'will', 'would', 'can', 'could', 'may', 'might', 'shall', 'should',
    'must', 'need', 'want', 'like', 'get', 'set', 'put', 'use',
    'give', 'gave', 'take', 'took', 'make', 'come', 'came',
    'see', 'saw', 'know', 'knew', 'think', 'believe',
    'say', 'said', 'tell', 'told', 'ask', 'asked',
    'help', 'send', 'sent', 'receive', 'received',
    'report', 'reports', 'apply', 'applied',
    'provide', 'provided', 'include', 'included', 'includes',
    'attach', 'attached', 'enclose', 'enclosed',
    'now', 'here', 'today', 'currently',
    'able', 'unable', 'available',
    'document', 'documents', 'record', 'records',
    'care', 'health', 'mental', 'physical',
    'living', 'housing', 'home', 'residence',
    'income', 'assets', 'debts', 'liability',
    'spouse', 'veteran', 'child', 'parent', 'sibling',
    'male', 'female', 'minor', 'adult',
    'employed', 'unemployed', 'retired',
    'self', 'other', 'same', 'different',
    # Construction/building terms (VA Form 26-1852 and similar)
    'footing', 'footings', 'drains', 'drain', 'foundation', 'foundations',
    'vents', 'vent', 'water', 'heater', 'proofing', 'termite',
    'fireplace', 'fireplaces', 'facing', 'lining', 'flue', 'chimney', 'chimneys',
    'wood', 'frame', 'joists', 'joist', 'grade', 'species',
    'material', 'materials', 'thickness', 'width', 'height', 'length', 'size', 'weight',
    'sash', 'screen', 'screens', 'cloth', 'shutters', 'shutter',
    'door', 'doors', 'window', 'windows', 'sill', 'sills', 'trim',
    'roof', 'roofing', 'shingles', 'shingle', 'flashing', 'gutter', 'gutters',
    'downspouts', 'downspout', 'membrane', 'paper', 'building',
    'masonry', 'veneer', 'brick', 'concrete', 'mortar', 'stucco',
    'plaster', 'coats', 'coat', 'joint', 'treatment',
    'insulation', 'sheathing', 'diagonal', 'bridging',
    'plumbing', 'sewer', 'house', 'supply', 'return',
    'heating', 'capacity', 'duct', 'panel', 'coil',
    'electric', 'electrical', 'circuits', 'circuit', 'wiring',
    'cabinet', 'cabinets', 'counter', 'countertop', 'shelf', 'shelves',
    'driveway', 'walk', 'front', 'rear', 'yard', 'side',
    'evergreen', 'shrubs', 'shrub', 'trees', 'tree', 'deciduous',
    'shade', 'planting', 'fence', 'fencing', 'wall', 'walls',
    'piles', 'pile', 'pier', 'column', 'columns', 'girder', 'girders',
    'excavation', 'grading', 'fill', 'backfill',
    'paint', 'painting', 'finish', 'decorating', 'stain', 'varnish',
    'hardware', 'accessories', 'miscellaneous', 'special',
    'attic', 'louvers', 'louver', 'backup', 'cheek', 'basement',
    'head', 'lineal', 'feet', 'foot', 'number', 'gage',
    'glass', 'prefabricated', 'reinforcing', 'model',
    'connected', 'discharges', 'into', 'exposure',
    'stairs', 'stair', 'risers', 'riser', 'treads', 'tread', 'railings', 'railing',
    'subfloor', 'underlayment', 'tile', 'tiles', 'ceramic', 'vinyl',
    'ceiling', 'ceilings', 'floor', 'floors', 'bath', 'kitchen',
    'garage', 'porch', 'deck', 'patio', 'carport',
    'septic', 'tank', 'well', 'gas', 'oil', 'fuel',
    'doorbell', 'outlet', 'outlets', 'switch', 'switches',
    'copper', 'steel', 'iron', 'aluminum', 'galvanized',
    'solar', 'central', 'air', 'conditioning',
    'dollar', 'dollars', 'baggage', 'fees', 'fee', 'mileage', 'miles',
    'observer', 'proxy', 'marital',
    # Additional terms found during visual testing
    'notify', 'notified', 'project', 'verify', 'verified',
    'instrument', 'committee', 'initials', 'initial',
    'dmo', 'vamc', 'visn', 'rd',
    'signature', 'signed', 'approved', 'disapproved',
    'justify', 'justification', 'anticipated',
]), key=lambda w: -len(w))  # Sort longest first for greedy matching


def split_concatenated_label(label):
    """
    Split a concatenated single-word label like 'Totalreceipts' into 'Total Receipts'.
    Uses greedy longest-match dictionary matching.
    Returns the split label or None if it can't be meaningfully split.
    """
    # Only process single-word labels that are long enough to be concatenated
    words_in_label = label.split()
    if len(words_in_label) != 1 or len(label) < 6:
        return None

    text = label.lower()

    # Don't split known English words
    if text in DONT_SPLIT:
        return None

    # Try greedy longest-match word splitting
    result = []
    pos = 0
    while pos < len(text):
        matched = False
        for word in VA_WORD_LIST:
            if text[pos:pos+len(word)] == word:
                result.append(word)
                pos += len(word)
                matched = True
                break
        if not matched:
            # Collect remaining chars as one chunk
            remaining = text[pos:]
            if remaining:
                result.append(remaining)
            break

    if len(result) <= 1:
        return None  # Couldn't split

    # Validate: every segment must be >= 3 chars (no "to", "of" fragments)
    # unless it's a known short word in the right context
    all_matched = all(seg in [w for w in VA_WORD_LIST] for seg in result)
    if not all_matched:
        return None  # Has unrecognized leftovers

    # Don't "split" if it just found the original word
    if len(result) == 1:
        return None

    # Reconstruct as proper label
    return ' '.join(result)


def compose_split_fields(properties):
    """
    Find and compose split fields: SSN parts, phone parts, zip parts.
    Returns (new_properties, changes_count).
    """
    # Group fields by their base (before the split suffix)
    ssn_groups = defaultdict(list)
    zip_groups = defaultdict(list)
    phone_groups = defaultdict(list)
    to_remove = set()

    for name in properties:
        m = SSN_PARTS_RE.match(name)
        if m:
            base = m.group(1)
            ssn_groups[base].append(name)
            continue

        # Standalone SSN parts: firstThreeNumbers, secondTwoNumbersSpouse, etc.
        m = STANDALONE_SSN_PARTS_RE.match(name)
        if m:
            prefix = m.group(1)  # e.g., "" or context before
            suffix = m.group(2)  # e.g., "Spouse", ""
            idx = m.group(3)     # e.g., "2", ""
            # Build a base key: prefix + "socialSecurityNumber" + suffix
            base = (prefix if prefix else '') + 'socialSecurityNumber' + suffix
            ssn_groups[base].append(name)
            continue

        m = ZIP_PARTS_RE.match(name)
        if m:
            base = m.group(1)
            zip_groups[base].append(name)
            continue

        m = PHONE_PARTS_RE.match(name)
        if m:
            base = m.group(1)
            phone_groups[base].append(name)
            continue

    changes = 0
    new_props = OrderedDict()

    # Track which keys to skip (they're being composed)
    composed_keys = set()

    for base, parts in ssn_groups.items():
        if len(parts) >= 2:
            composed_keys.update(parts)
            # Only add if base doesn't already exist
            if base not in properties:
                new_props[base] = {
                    "type": "string",
                    "pattern": "^\\d{3}-?\\d{2}-?\\d{4}$",
                    "maxLength": 11,
                    "x-va-field": {"label": humanize_label(base), "widget": "ssn"}
                }
                changes += 1
            else:
                # Base already exists, just remove the parts
                changes += 1

    for base, parts in zip_groups.items():
        if len(parts) >= 2:
            composed_keys.update(parts)
            if base not in properties:
                new_props[base] = {
                    "type": "string",
                    "pattern": "^\\d{5}(-\\d{4})?$",
                    "x-va-field": {"label": humanize_label(base), "widget": "zip"}
                }
                changes += 1
            else:
                changes += 1

    for base, parts in phone_groups.items():
        if len(parts) >= 2:
            composed_keys.update(parts)
            if base not in properties:
                new_props[base] = {
                    "type": "string",
                    "pattern": "^\\d{10}$",
                    "x-va-field": {"label": humanize_label(base), "widget": "phone"}
                }
                changes += 1
            else:
                changes += 1

    # Build final properties: original order minus composed parts, plus new composed fields
    result = OrderedDict()
    inserted_bases = set()

    for name, defn in properties.items():
        if name in composed_keys:
            # Find which group this belongs to and insert the composed field at first occurrence
            for base, parts in {**ssn_groups, **zip_groups, **phone_groups}.items():
                if name in parts and base not in inserted_bases and len(parts) >= 2:
                    if base in new_props:
                        result[base] = new_props[base]
                    inserted_bases.add(base)
                    break
            continue
        result[name] = defn

    return result, changes


def process_schema(filepath, dry_run=False):
    """Process a single schema file, cleaning up field names."""
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

    new_properties = OrderedDict()
    renamed_map = {}  # old_name → new_name for updating required array

    for name, defn in properties.items():
        original_name = name
        new_name = name
        label_changed = False

        # 1. Check if it's a non-user field
        if name.lower().replace('_', '') in NON_USER_FIELDS:
            stats["non_user_removed"] += 1
            stats["fields_removed"] += 1
            total_changes += 1
            continue

        # 2. Try to clean XFA remnants — check for XFA patterns ANYWHERE in the name
        # But exclude "ddForm214" (DD Form 214 is a real document name)
        is_dd_form = bool(re.match(r'^dd[Ff]orm\d+$', name))
        has_xfa = not is_dd_form and (
            bool(XFA_STRUCTURAL.search(name)) or
            name.startswith('#') or
            name.startswith('field_') or
            bool(re.search(r'(?:form\d+|subform\d*|topmostsubform)', name, re.I)) or
            bool(re.match(r'^\d+form', name, re.I)) or
            bool(re.match(r'^[a-z](?:subform|page\d|table\d)', name, re.I)) or  # fSubform..., fPage1...
            bool(re.match(r'^[a-z]?[Pp]age_?\d', name)) or  # fPage_1Field47, fPage1field47, Page1CheckBox1
            bool(re.search(r'table\d+(?:header)?row\d*subform', name, re.I))  # table3headerRowSubform...
        )
        if has_xfa:
            extracted = extract_semantic_name_from_xfa(name)
            if extracted:
                new_name = to_camel_case(extracted)
                stats["xfa_stripped"] += 1
                total_changes += 1
            else:
                # Unsalvageable XFA — remove the field
                stats["fields_removed"] += 1
                total_changes += 1
                continue

        # 3. Strip bare type prefixes
        if new_name != name or TYPE_PREFIX_RE.match(new_name):
            stripped = strip_type_prefix(new_name)
            if stripped != new_name:
                new_name = stripped
                stats["type_prefixes_stripped"] += 1
                total_changes += 1

        # 4. Check for generic names after all cleaning
        if GENERIC_RE.match(new_name):
            stats["fields_removed"] += 1
            total_changes += 1
            continue

        # 5. Clean overly verbose names
        if len(new_name) > 80:
            cleaned = clean_verbose_name(new_name)
            if cleaned is None:
                stats["fields_removed"] += 1
                total_changes += 1
                continue
            new_name = cleaned

        # 6. Ensure camelCase
        if new_name and not re.match(r'^[a-z]', new_name):
            new_name = new_name[0].lower() + new_name[1:]

        # 7. Fix the label in x-va-field
        if isinstance(defn, dict):
            va_field = defn.get("x-va-field", {})
            old_label = va_field.get("label", "")

            # Generate a proper human-readable label from the clean name
            proper_label = humanize_label(new_name) if new_name else ""

            # Always check if the regenerated label is better than the current one
            # This catches cases where humanize_label has been improved since the last run
            if old_label and proper_label and old_label != proper_label:
                # The regenerated label is different — decide which is better
                old_words = old_label.split()
                new_words = proper_label.split()
                # Prefer the label with more words (more descriptive)
                # unless the old label came from original PDF text (indicated by
                # having special chars, parens, or ALL CAPS sections)
                has_pdf_markers = bool(
                    re.search(r'[(),.]', old_label) or
                    re.search(r'[A-Z]{3,}', old_label) or
                    len(old_label) > 60
                )
                if not has_pdf_markers:
                    if len(new_words) > len(old_words) or proper_label != old_label:
                        va_field["label"] = proper_label
                        defn["x-va-field"] = va_field
                        stats["labels_fixed"] += 1
                        total_changes += 1
                        # Update old_label for subsequent checks
                        old_label = proper_label

            needs_label_fix = False
            if old_label:
                # Comprehensive bad label detection — catch EVERY pattern
                has_bad_label = bool(
                    # XFA structural junk: Form1, #subform, Subform, Page refs
                    re.search(r'(form\d|subform|#subform)', old_label, re.IGNORECASE) or
                    # "F Page X ..." prefix (XFA page reference in label)
                    re.match(r'^F\s+(?:Page|Subform|Sub\s*form)\s*\d', old_label, re.IGNORECASE) or
                    # Page/Table/Row/Cell structural refs (but not "Page of Pages")
                    (re.search(r'(Page\d|Table\d|Row\d|Cell\d)', old_label) and
                     not re.search(r'Page\s+of', old_label, re.IGNORECASE)) or
                    # Widget type as label: "Check Box 1", "Radio Button 2", "Text Field 3"
                    re.match(r'^(Checkbox|Check\s*Box|Radio\s*Button|Text\s*Field|Text\s*Box)\s*\d', old_label, re.IGNORECASE) or
                    # Spaced-out characters: "Y E S", "N O", "S S N", "V A", "M I"
                    re.match(r'^([A-Z]\s){2,}[A-Z]?\s', old_label) or
                    # Nonsense/truncated labels (just numbers, punctuation, or < 2 chars)
                    re.match(r'^\d+[A-Z]?\.\s*$', old_label) or
                    len(old_label.strip()) < 2
                )

                # Check for spaced-out characters WITHIN labels (e.g., "Veterans S S N")
                # These should be fixed to proper acronyms
                has_spaced_chars = bool(re.search(r'\b([A-Z]\s){2,}[A-Z]\b', old_label))

                # Check if label is ALL CAPS or mostly caps (from text inference)
                alpha_chars = [c for c in old_label if c.isalpha()]
                upper_ratio = sum(1 for c in alpha_chars if c.isupper()) / max(len(alpha_chars), 1)
                is_all_caps = upper_ratio > 0.7 and len(old_label) > 3

                # Check for underscores in labels (raw field name artifacts)
                has_underscores = '_' in old_label

                if has_bad_label:
                    needs_label_fix = True
                elif has_underscores:
                    # Replace underscores with spaces, clean up, and re-humanize
                    fixed = old_label.replace('_', ' ')
                    fixed = re.sub(r'\s+', ' ', fixed).strip()
                    # Re-insert spaces around digits between words
                    fixed = re.sub(r'([a-zA-Z])(\d+)([a-zA-Z])', r'\1 \2 \3', fixed)
                    if fixed != old_label:
                        va_field["label"] = fixed
                        defn["x-va-field"] = va_field
                        stats["labels_fixed"] += 1
                        total_changes += 1
                        old_label = fixed
                elif has_spaced_chars:
                    # Fix spaced-out acronyms in otherwise OK labels
                    fixed = old_label
                    fixed = re.sub(r'\bS S N\b', 'SSN', fixed)
                    fixed = re.sub(r'\bV A\b', 'VA', fixed)
                    fixed = re.sub(r'\bM I\b', 'MI', fixed)
                    fixed = re.sub(r'\bD O B\b', 'DOB', fixed)
                    fixed = re.sub(r'\bP O\b', 'PO', fixed)
                    fixed = re.sub(r'\bZ I P\b', 'ZIP', fixed)
                    fixed = re.sub(r'\bI D\b', 'ID', fixed)
                    fixed = re.sub(r'\bU S\b', 'US', fixed)
                    # Generic: collapse any remaining A B C → ABC
                    fixed = re.sub(r'\b([A-Z])\s([A-Z])\s([A-Z])\b', r'\1\2\3', fixed)
                    fixed = re.sub(r'\b([A-Z])\s([A-Z])\b', r'\1\2', fixed)
                    if fixed != old_label:
                        va_field["label"] = fixed
                        defn["x-va-field"] = va_field
                        stats["labels_fixed"] += 1
                        total_changes += 1
                elif not has_spaced_chars:
                    # Check for concatenated single-word labels like "Totalreceipts" → "Total Receipts"
                    split_words = old_label.split()
                    new_words = []
                    label_was_split = False
                    for w in split_words:
                        split_result = split_concatenated_label(w)
                        if split_result:
                            new_words.append(split_result)
                            label_was_split = True
                        else:
                            new_words.append(w)
                    if label_was_split:
                        fixed_label = ' '.join(new_words)
                        # Re-run humanize to fix capitalization
                        fixed_label = humanize_label(to_camel_case(fixed_label))
                        va_field["label"] = fixed_label
                        defn["x-va-field"] = va_field
                        stats["labels_fixed"] += 1
                        total_changes += 1

                    if is_all_caps and va_field.get("label") == old_label:
                        # Normalize ALL CAPS label to title case
                        normalized = old_label.title()
                        # Fix common issues in title-cased labels
                        normalized = re.sub(r'\(?Mm/Dd/Yyyy\)?', '(MM/DD/YYYY)', normalized)
                        normalized = re.sub(r'\bMm\b', 'MM', normalized)
                        normalized = re.sub(r'\bDd\b', 'DD', normalized)
                        normalized = re.sub(r'\bYyyy\b', 'YYYY', normalized)
                        normalized = re.sub(r"\bVeteran'?S\b", "Veteran's", normalized)
                        normalized = re.sub(r'\bVa\b', 'VA', normalized)
                        normalized = re.sub(r'\bSsn\b', 'SSN', normalized)
                        normalized = re.sub(r'\bZip\b', 'ZIP', normalized)
                        normalized = re.sub(r'\bId\b', 'ID', normalized)
                        normalized = re.sub(r'\bUs\b', 'US', normalized)
                        normalized = re.sub(r'\bP\.?O\.?\b', 'PO', normalized)
                        normalized = re.sub(r'\(([a-z])', lambda m: '(' + m.group(1).upper(), normalized)
                        va_field["label"] = normalized
                        defn["x-va-field"] = va_field
                        stats["labels_fixed"] += 1
                        total_changes += 1
            else:
                needs_label_fix = True

            if needs_label_fix and proper_label:
                if "x-va-field" not in defn:
                    defn["x-va-field"] = {}
                defn["x-va-field"]["label"] = proper_label
                defn["x-va-field"] = {**defn.get("x-va-field", {}), "label": proper_label}
                stats["labels_fixed"] += 1
                total_changes += 1

        # Track the rename
        if new_name != original_name:
            renamed_map[original_name] = new_name
            stats["fields_renamed"] += 1

        # Handle key collisions
        final_key = new_name
        suffix = 2
        while final_key in new_properties:
            final_key = new_name + str(suffix)
            suffix += 1

        new_properties[final_key] = defn

    # 8. Compose split fields (SSN, phone, zip parts)
    new_properties, compose_changes = compose_split_fields(new_properties)
    stats["fields_composed"] += compose_changes
    total_changes += compose_changes

    if total_changes > 0:
        stats["schemas_modified"] += 1
        schema["properties"] = dict(new_properties)

        # Update required array
        if "required" in schema:
            new_required = []
            for req in schema["required"]:
                if req in renamed_map:
                    mapped = renamed_map[req]
                    if mapped in new_properties and mapped not in new_required:
                        new_required.append(mapped)
                elif req in new_properties and req not in new_required:
                    new_required.append(req)
            schema["required"] = new_required

        # Update metadata
        meta = schema.get("x-va-metadata", {})
        meta["fieldNameFixedAt"] = datetime.now(timezone.utc).isoformat()
        meta["composedFields"] = len(new_properties)

        # Recalculate quality metrics
        bad_count = sum(1 for n in new_properties if GENERIC_RE.match(n) or XFA_STRUCTURAL.match(n))
        meta["needsReviewCount"] = bad_count
        if len(new_properties) > 0:
            meta["coveragePercent"] = round((len(new_properties) - bad_count) / len(new_properties) * 100)
        schema["x-va-metadata"] = meta

        if dry_run:
            print(f"  [DRY RUN] {form_name}: {total_changes} changes")
        else:
            with open(filepath, 'w') as f:
                json.dump(schema, f, indent=2)
            print(f"  FIXED {form_name}: {total_changes} changes")

        return True
    return False


def main():
    parser = argparse.ArgumentParser(description="Fix field names in VA form schemas")
    parser.add_argument("--dry-run", action="store_true", help="Show changes without modifying files")
    parser.add_argument("--form", type=str, help="Process only a specific form by name")
    args = parser.parse_args()

    print("=" * 70)
    print("VA Form Schema — Field Name Fixer")
    print("=" * 70)
    if args.dry_run:
        print("[DRY RUN MODE]")
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

    # Print summary
    print()
    print("=" * 70)
    print("FIELD NAME FIX SUMMARY")
    print("=" * 70)
    print(f"Schemas processed:        {stats['schemas_processed']}")
    print(f"Schemas modified:         {stats['schemas_modified']}")
    print(f"Fields renamed:           {stats['fields_renamed']}")
    print(f"  XFA paths stripped:     {stats['xfa_stripped']}")
    print(f"  Type prefixes stripped: {stats['type_prefixes_stripped']}")
    print(f"Fields removed:           {stats['fields_removed']}")
    print(f"  Non-user fields:        {stats['non_user_removed']}")
    print(f"Fields composed:          {stats['fields_composed']}")
    print(f"Labels fixed:             {stats['labels_fixed']}")


if __name__ == "__main__":
    main()
