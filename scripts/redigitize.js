#!/usr/bin/env node
/**
 * Aquia Form Re-Digitizer (Node.js)
 *
 * Downloads flat VA PDFs and re-extracts fields using pdf-parse.
 * No CORS restrictions — runs locally.
 *
 * Usage:
 *   cd aquiaformbuilder
 *   npm install pdf-parse pdf-lib
 *   node scripts/redigitize.js
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

let pdfParse, PDFLib;
try {
    pdfParse = require('pdf-parse');
} catch (e) {
    console.error('Missing dependency: npm install pdf-parse');
    process.exit(1);
}
try {
    PDFLib = require('pdf-lib');
} catch (e) {
    console.log('pdf-lib not found — XFA extraction disabled');
}

// ─── Config ───
const ORGS = [
    { id: 'vba', dir: 'schemas/vba' },
    { id: 'vha', dir: 'schemas/va/vha' },
    { id: 'nca', dir: 'schemas/va/nca' },
    { id: 'facilities', dir: 'schemas/va/facilities' },
    { id: 'admin', dir: 'schemas/va/admin' },
    { id: 'other', dir: 'schemas/va/other' },
];

// CLI flags
const ARGS = process.argv.slice(2);
const USE_QUEUE = ARGS.includes('--queue');  // Process from redigitize-queue.json
const DRY_RUN = ARGS.includes('--dry-run');
const FORM_FILTER = ARGS.find(a => a.startsWith('--form='))?.split('=')[1];

const STATS = { total: 0, processed: 0, withFields: 0, totalFields: 0, errors: 0 };

// ─── HTTP fetch with redirect following ───
function fetchUrl(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 AquiaFormBuilder/1.0' } }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                let redirect = res.headers.location;
                if (redirect.startsWith('/')) {
                    const u = new URL(url);
                    redirect = u.protocol + '//' + u.host + redirect;
                }
                return fetchUrl(redirect).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

// ─── Field inference from text ───
function inferFieldsFromText(text) {
    const fields = [];
    const seenLabels = new Set();
    const lines = text.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.length < 3) continue;

        const patterns = [
            // "Label: ____" or "Label: "
            { regex: /^([A-Za-z][^:]{2,50}):\s*[_\s]*$/, type: 'text' },
            // "Label:" followed by content
            { regex: /^([A-Za-z][^:]{2,40}):\s+/, type: 'text' },
            // Numbered items: "1. Something" or "1a. Something"
            { regex: /^\d+[a-z]?\.\s+(.{3,60})/, type: 'text' },
            // Checkbox-style: "[ ] Something"
            { regex: /\[\s*\]\s+(.{3,60})/, type: 'checkbox' },
            // YES/NO patterns
            { regex: /^(.{3,50})\s*(?:YES|NO)\s/i, type: 'radio' },
            // Date patterns
            { regex: /^(.{3,50})\s*\(?(?:MM\/DD\/YYYY|mm\/dd\/yyyy|Date)\)?/i, type: 'date' },
            // Common VA field labels
            { regex: /^((?:Name|First Name|Last Name|Middle Name|Address|City|State|ZIP|Phone|Email|SSN|Social Security|Date of Birth|Signature|VA File Number|Service Number|Veteran['']?s? Name)[^:]*):?\s*/i, type: 'text' },
            // Label followed by underscores
            { regex: /^([A-Za-z][^_]{2,50})\s*[_]{3,}/, type: 'text' },
        ];

        for (const pattern of patterns) {
            const match = trimmed.match(pattern.regex);
            if (match) {
                const label = (match[1] || '').trim();
                if (label && !seenLabels.has(label.toLowerCase()) && label.length > 2 && label.length < 80) {
                    // Skip noise
                    if (/^(page|form|va |department|section|part |omb|exp|public)/i.test(label)) continue;
                    if (/^\d+$/.test(label)) continue;

                    seenLabels.add(label.toLowerCase());

                    // Determine more specific type from label
                    let fieldType = pattern.type;
                    const lowerLabel = label.toLowerCase();
                    if (/date|birth|dob/i.test(lowerLabel)) fieldType = 'date';
                    else if (/phone|tel/i.test(lowerLabel)) fieldType = 'phone';
                    else if (/email/i.test(lowerLabel)) fieldType = 'email';
                    else if (/ssn|social security/i.test(lowerLabel)) fieldType = 'ssn';
                    else if (/address/i.test(lowerLabel)) fieldType = 'address';
                    else if (/state/i.test(lowerLabel)) fieldType = 'select';
                    else if (/zip/i.test(lowerLabel)) fieldType = 'zip';
                    else if (/signature/i.test(lowerLabel)) fieldType = 'signature';

                    fields.push({
                        label,
                        type: fieldType,
                        source: 'text-inference'
                    });
                }
                break;
            }
        }
    }
    return fields;
}

// ─── Extract AcroForm fields via pdf-lib ───
async function extractAcroFormFields(buffer) {
    if (!PDFLib) return [];
    try {
        const pdfDoc = await PDFLib.PDFDocument.load(buffer, { ignoreEncryption: true });
        const form = pdfDoc.getForm();
        const pdfFields = form.getFields();
        return pdfFields.map((f, i) => {
            const rawName = f.getName();
            const type = f.constructor.name.replace('PDF', '').replace('Field', '').toLowerCase();
            const mappedType = type === 'text' ? 'text' : type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : type === 'dropdown' || type === 'optionlist' ? 'select' : 'text';

            // Try to get a good property key from the raw name
            const propertyKey = humanizeFieldName(rawName);
            const label = humanize(rawName);

            return {
                label: label,
                rawName: rawName,
                propertyKey: propertyKey,  // null if name is garbage (XFA/generic)
                needsLabel: !propertyKey,  // flag for text-inference fallback
                type: mappedType,
                source: 'acroform'
            };
        });
    } catch (e) {
        return [];
    }
}

// ─── Field name quality helpers ───

// Patterns that indicate raw XFA/PDF structural names (NOT semantic field names)
const XFA_STRUCTURAL_RE = /^(topmostSubform|form\d|Page\d|Subform\d|Table\d|Row\d|Cell\d|#subform|root|body)/i;
const XFA_PATH_RE = /\[\d+\]/g;  // Array indices like [0], [1]
const GENERIC_RE = /^(checkbox\d*|checkBox\d*|yescheckbox\d*|nocheckbox\d*|radioButton\d*|radioButtonList|textField\d*|textBox\d*|field\d*|input\d*|text\d*|button\d*|group\d*|untitled\d*|unknown\d*|newField\d*|default\d*)$/i;

/**
 * Convert a raw PDF/XFA field name into a human-readable property key.
 * Examples:
 *   "topmostSubform[0].Page1[0].SSN[0]" → "ssn"
 *   "form1[0].subform43[0].textfield10[0]" → null (unsalvageable)
 *   "VeteranLastName" → "veteranLastName"
 *   "Date Signed" → "dateSigned"
 */
function humanizeFieldName(rawName) {
    if (!rawName) return null;

    // Strip XFA array indices: field[0].child[1] → field.child
    let cleaned = rawName.replace(XFA_PATH_RE, '');

    // If it's an XFA path, try to extract the last meaningful segment
    if (cleaned.includes('.')) {
        const segments = cleaned.split('.');
        // Walk backwards to find a non-structural segment
        for (let i = segments.length - 1; i >= 0; i--) {
            const seg = segments[i];
            if (!XFA_STRUCTURAL_RE.test(seg) && !/^(Page|Subform|Table|Row|Cell)\d*$/i.test(seg)) {
                cleaned = seg;
                break;
            }
        }
    }

    // Strip common XFA prefixes
    cleaned = cleaned
        .replace(/^(topmostSubform|form\d+|subform\d+|page\d+)/i, '')
        .replace(/^[._\-]+/, '');

    // If what's left is a generic name (textfield10, checkbox3), it's unsalvageable
    if (!cleaned || GENERIC_RE.test(cleaned) || /^(textfield|textbox|checkbox|radiobutton)\d+$/i.test(cleaned)) {
        return null;  // Signal that this field needs a label from text inference
    }

    // Convert to camelCase
    let camel = cleaned
        .replace(/[._\-\[\]]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    // Split on camelCase boundaries and rejoin as proper camelCase
    camel = camel
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .split(/\s+/)
        .map((word, i) => i === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join('');

    return camel || null;
}

/**
 * Original simple humanize for display labels (not property keys).
 */
function humanize(name) {
    return name
        .replace(XFA_PATH_RE, '')
        .replace(/([A-Z])/g, ' $1')
        .replace(/[._\-\[\]]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^\w/, c => c.toUpperCase());
}

/**
 * Check if a field name is "good quality" — meaningful and not generic/XFA.
 */
function isGoodFieldName(name) {
    if (!name) return false;
    if (GENERIC_RE.test(name)) return false;
    if (XFA_STRUCTURAL_RE.test(name)) return false;
    if (/^(textfield|textbox|checkbox|radiobutton)\d+$/i.test(name)) return false;
    if (name.length < 3) return false;
    return true;
}

// ─── Build JSON Schema from fields ───
function buildSchema(formName, fields, originalMeta, pageCount) {
    const properties = {};
    const required = [];
    let needsReviewCount = 0;

    for (const field of fields) {
        // Determine the property key:
        // 1. Use cleaned propertyKey if available (humanized from AcroForm)
        // 2. Fall back to label-based key from text inference
        // 3. Last resort: mark as needs review
        let key = field.propertyKey;
        if (!key) {
            // Generate from label
            key = field.label.toLowerCase()
                .replace(/[^a-z0-9]+/g, '_')
                .replace(/^_|_$/g, '');

            // Convert snake_case to camelCase
            key = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
        }

        // Final quality check on the key
        if (!isGoodFieldName(key)) {
            needsReviewCount++;
        }

        // Avoid key collisions
        let finalKey = key;
        let suffix = 2;
        while (properties[finalKey]) {
            finalKey = key + suffix++;
        }

        const prop = { type: 'string' };

        switch (field.type) {
            case 'date':
                prop.format = 'date';
                break;
            case 'checkbox':
                prop.type = 'boolean';
                break;
            case 'phone':
                prop.pattern = '^\\d{10}$';
                break;
            case 'ssn':
                prop.pattern = '^\\d{3}-?\\d{2}-?\\d{4}$';
                prop.maxLength = 11;
                break;
            case 'email':
                prop.format = 'email';
                break;
            case 'zip':
                prop.pattern = '^\\d{5}(-\\d{4})?$';
                break;
            case 'select':
                prop.type = 'string';
                break;
        }

        if (field.label) {
            prop['x-va-field'] = { label: field.label, widget: field.type };
        }

        properties[finalKey] = prop;
    }

    // ─── Compose date fragments ───
    // Look for keys like dateXYear, dateXMonth, dateXDay and merge into dateX
    const dateFragRE = /^(.*?)(Year|Month|Day)$/i;
    const dateGroups = {};
    const fragmentKeys = new Set();

    for (const key of Object.keys(properties)) {
        const m = key.match(dateFragRE);
        if (m) {
            const base = m[1];
            if (!dateGroups[base]) dateGroups[base] = [];
            dateGroups[base].push(key);
            fragmentKeys.add(key);
        }
    }

    for (const [base, fragments] of Object.entries(dateGroups)) {
        if (fragments.length >= 2) {
            // Remove fragments and add composed field
            for (const frag of fragments) {
                delete properties[frag];
            }
            properties[base] = { type: 'string', format: 'date' };
        }
    }

    // ─── Remove case duplicates ───
    const lowerMap = {};
    const dupeKeys = [];
    for (const key of Object.keys(properties)) {
        const lower = key.toLowerCase();
        if (lowerMap[lower]) {
            dupeKeys.push(key);  // Remove the later one
        } else {
            lowerMap[lower] = key;
        }
    }
    for (const key of dupeKeys) {
        delete properties[key];
    }

    // ─── Calculate honest coverage ───
    const totalProps = Object.keys(properties).length;
    const goodProps = Object.keys(properties).filter(k => isGoodFieldName(k)).length;
    const coveragePercent = totalProps > 0 ? Math.round((goodProps / totalProps) * 100) : 0;

    return {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        title: formName,
        type: 'object',
        required,
        properties,
        'x-va-metadata': {
            ...originalMeta,
            totalFields: fields.length,
            composedFields: totalProps,
            coveragePercent: coveragePercent,
            needsReviewCount: needsReviewCount,
            status: totalProps > 0 ? 'digitized' : 'flat',
            pageCount: pageCount || originalMeta.pageCount || 0,
            redigitizedAt: new Date().toISOString(),
            extractionSources: [...new Set(fields.map(f => f.source))]
        }
    };
}

// ─── Process a single form ───
async function processForm(form, orgDir) {
    // Normalize name: VBA index uses "file" (e.g. "21-0538.json"), others use "name"
    const formName = form.name || (form.file ? form.file.replace(/\.json$/, '') : 'unknown');
    const formUrl = form.formUrl;
    if (!formUrl) {
        console.log(`  ⚠ ${formName}: no formUrl, skipping`);
        return null;
    }

    try {
        console.log(`  ⬇ ${formName}: downloading PDF...`);
        const buffer = await fetchUrl(formUrl);
        console.log(`    ${buffer.length} bytes downloaded`);

        // Extract with pdf-parse (text)
        const parsed = await pdfParse(buffer);
        const textFields = inferFieldsFromText(parsed.text);
        console.log(`    Text inference: ${textFields.length} fields from ${parsed.numpages} pages`);

        // Extract AcroForm fields
        const acroFields = await extractAcroFormFields(buffer);
        console.log(`    AcroForm: ${acroFields.length} fields`);

        // ─── Smart merge: use text-inferred labels to rescue AcroForm fields with bad names ───
        // For AcroForm fields that have garbage names (needsLabel=true), try to match
        // them with text-inferred fields by position/count. This is imperfect but better
        // than keeping names like "form10subform43textfield10".
        const goodAcroFields = acroFields.filter(f => !f.needsLabel);
        const badAcroFields = acroFields.filter(f => f.needsLabel);
        const usedTextLabels = new Set();

        // First pass: match bad AcroForm fields with unused text-inferred fields
        for (const acroField of badAcroFields) {
            // Try to find a text-inferred field with a matching type
            const match = textFields.find(tf =>
                !usedTextLabels.has(tf.label.toLowerCase()) &&
                (tf.type === acroField.type || acroField.type === 'text')
            );
            if (match) {
                // Adopt the text-inferred label
                acroField.label = match.label;
                acroField.propertyKey = match.label.toLowerCase()
                    .replace(/[^a-z0-9]+/g, '_')
                    .replace(/^_|_$/g, '')
                    .replace(/_([a-z])/g, (_, c) => c.toUpperCase());
                acroField.needsLabel = false;
                acroField.source = 'acroform+text-inference';
                usedTextLabels.add(match.label.toLowerCase());
            }
        }

        // Combine: good acro fields + rescued acro fields + remaining text fields
        const rescuedFields = [...goodAcroFields, ...badAcroFields];
        const remainingText = textFields.filter(tf => !usedTextLabels.has(tf.label.toLowerCase()));
        const allFields = [...rescuedFields, ...remainingText];

        // Deduplicate by label
        const seen = new Map();
        const unique = allFields.filter(f => {
            const k = f.label.toLowerCase();
            if (seen.has(k)) return false;
            seen.set(k, true);
            return true;
        });

        console.log(`    Total unique: ${unique.length} fields`);

        // Read original schema metadata
        const schemaFileName = form.fileName || form.file || (formName + '.json');
        const schemaPath = path.join(orgDir, schemaFileName);
        let originalMeta = {};
        if (fs.existsSync(schemaPath)) {
            const orig = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
            originalMeta = orig['x-va-metadata'] || {};
        }

        // Build new schema
        const schema = buildSchema(formName, unique, originalMeta, parsed.numpages);

        // Write schema file
        fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2));
        console.log(`    ✓ Wrote ${schemaPath} (${unique.length} fields)`);

        STATS.processed++;
        STATS.totalFields += unique.length;
        if (unique.length > 0) STATS.withFields++;

        const meta = schema['x-va-metadata'];
        return {
            name: formName,
            fields: unique.length,
            composedFields: meta.composedFields,
            coveragePercent: meta.coveragePercent,
            needsReviewCount: meta.needsReviewCount,
            status: meta.status
        };
    } catch (e) {
        console.log(`    ✗ Error: ${e.message}`);
        STATS.processed++;
        STATS.errors++;
        return { name: formName, fields: 0, error: e.message };
    }
}

// ─── Main ───
async function main() {
    console.log('═══════════════════════════════════════════');
    console.log('  Aquia Form Re-Digitizer v2');
    console.log('  Smart field naming + quality validation');
    console.log('═══════════════════════════════════════════');
    if (USE_QUEUE) console.log('  Mode: Processing from redigitize-queue.json');
    if (DRY_RUN) console.log('  [DRY RUN — no files will be modified]');
    if (FORM_FILTER) console.log(`  Filter: ${FORM_FILTER} only`);
    console.log('');

    // Load the redigitize queue if --queue flag is set
    let queuedForms = null;
    if (USE_QUEUE) {
        const queuePath = 'redigitize-queue.json';
        if (fs.existsSync(queuePath)) {
            const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
            queuedForms = new Set(queue.forms.map(f => f.form));
            console.log(`Loaded queue: ${queuedForms.size} forms to redigitize\n`);
        } else {
            console.log('No redigitize-queue.json found. Run schema-post-processor.py first.');
            process.exit(1);
        }
    }

    for (const org of ORGS) {
        const indexPath = path.join(org.dir, 'index.json');
        if (!fs.existsSync(indexPath)) {
            console.log(`Skipping ${org.id}: no index.json at ${indexPath}`);
            continue;
        }

        const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        const forms = Array.isArray(index.forms) ? index.forms : Object.values(index.forms || {});

        // Determine which forms to process
        // Note: VBA index uses "file" (e.g. "21-0538.json"), other orgs use "name"
        const getFormName = (f) => f.name || (f.file ? f.file.replace(/\.json$/, '') : '');
        let targetForms;
        if (queuedForms) {
            // Queue mode: process forms that are in the redigitization queue
            targetForms = forms.filter(f => queuedForms.has(getFormName(f)));
        } else if (FORM_FILTER) {
            targetForms = forms.filter(f => getFormName(f) === FORM_FILTER);
        } else {
            // Default: flat forms only
            targetForms = forms.filter(f => f.status === 'flat' || (f.totalFields || 0) === 0);
        }

        if (targetForms.length === 0) {
            console.log(`${org.id.toUpperCase()}: No forms to process — skipping\n`);
            continue;
        }

        console.log(`\n${org.id.toUpperCase()}: ${targetForms.length} forms to process\n`);
        STATS.total += targetForms.length;

        const results = [];
        for (const form of targetForms) {
            const result = await processForm(form, org.dir);
            if (result) results.push(result);
            // Small delay to be polite to va.gov
            await new Promise(r => setTimeout(r, 500));
        }

        // Update index.json
        const updatedForms = (Array.isArray(index.forms) ? index.forms : Object.values(index.forms)).map(f => {
            const result = results.find(r => r.name === (f.name || (f.file ? f.file.replace(/\.json$/, '') : '')));
            if (result && !result.error) {
                return {
                    ...f,
                    totalFields: result.fields,
                    composedFields: result.composedFields || result.fields,
                    coveragePercent: result.coveragePercent || (result.fields > 0 ? 100 : 0),
                    needsReviewCount: result.needsReviewCount || 0,
                    status: result.status,
                    redigitizedAt: new Date().toISOString()
                };
            }
            return f;
        });

        // Always save as array (frontend requires array format)
        index.forms = updatedForms;

        fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
        console.log(`\n  Updated ${indexPath}`);
    }

    console.log('\n═══════════════════════════════════════════');
    console.log('  RESULTS');
    console.log('═══════════════════════════════════════════');
    console.log(`  Total flat forms:  ${STATS.total}`);
    console.log(`  Processed:         ${STATS.processed}`);
    console.log(`  With fields:       ${STATS.withFields}`);
    console.log(`  Total fields:      ${STATS.totalFields}`);
    console.log(`  Errors:            ${STATS.errors}`);
    console.log(`  Still flat:        ${STATS.processed - STATS.withFields - STATS.errors}`);
    console.log('═══════════════════════════════════════════\n');
}

main().catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
});
