#!/usr/bin/env node
/**
 * Schema Enrichment Script
 *
 * Downloads each VA form's PDF, extracts the title, OMB number, and instructions,
 * then populates x-va-form metadata in the corresponding JSON schema.
 *
 * This makes every form render with a proper heading and instructions instead of
 * the generic "Legacy Form Schema" banner.
 *
 * Usage: node scripts/enrich-schemas.js [--form FORM_NAME] [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const SCHEMAS_DIR = path.join(__dirname, '..', 'schemas');

// ─── PDF download helper ───
function downloadPDF(url, timeout = 15000) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        const req = protocol.get(url, { timeout }, (res) => {
            // Follow redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return downloadPDF(res.headers.location, timeout).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

// ─── Text parsing helpers ───

/**
 * Extract form title from PDF text.
 * VA forms typically have a header like:
 *   "VA FORM 21-0779" followed by the title on the next line(s)
 *   Or "REQUEST FOR NURSING HOME INFORMATION..."
 *   Or "DEPARTMENT OF VETERANS AFFAIRS" then the title
 */
function extractFormTitle(text, formNumber) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    // Strategy 1: Find "VA FORM XX-XXXX" and take text near it as the title
    const formNumNorm = formNumber.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    let titleCandidate = '';

    for (let i = 0; i < Math.min(lines.length, 40); i++) {
        const line = lines[i];
        const lineNorm = line.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

        // Check if this line contains the form number
        if (lineNorm.includes(formNumNorm) || lineNorm.includes('vaform')) {
            // Look at lines around this for a title
            // The title is usually right after or before the form number line
            for (let j = Math.max(0, i - 3); j < Math.min(lines.length, i + 5); j++) {
                const candidate = lines[j];
                // Skip lines that are just the form number, dates, OMB numbers
                if (candidate.match(/^(VA\s*FORM|OMB\s*(Approved|Control)|Exp(ires|iration)|Page\s*\d|Respondent)/i)) continue;
                if (candidate.match(/^\d{4}[-/]\d{2}[-/]\d{2}$/)) continue;
                if (candidate.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() === formNumNorm) continue;
                if (candidate.length < 5) continue;

                // This looks like a title - prefer UPPERCASE lines (form titles are usually caps)
                if (candidate === candidate.toUpperCase() && candidate.length > 10) {
                    titleCandidate = candidate;
                    // Check if next line is also part of the title (continuation)
                    if (j + 1 < lines.length && lines[j + 1] === lines[j + 1].toUpperCase() &&
                        lines[j + 1].length > 10 && !lines[j + 1].match(/^(VA\s*FORM|OMB|SECTION|PART\s)/i)) {
                        titleCandidate += ' ' + lines[j + 1];
                    }
                    break;
                }
                if (!titleCandidate && candidate.length > 15) {
                    titleCandidate = candidate;
                }
            }
            if (titleCandidate) break;
        }
    }

    // Strategy 2: If no title found, look for the first substantial uppercase line
    if (!titleCandidate) {
        for (let i = 0; i < Math.min(lines.length, 20); i++) {
            const line = lines[i];
            if (line === line.toUpperCase() && line.length > 15 &&
                !line.match(/^(DEPARTMENT|VA\s*FORM|OMB|PRIVACY|PAPERWORK)/i)) {
                titleCandidate = line;
                break;
            }
        }
    }

    // Clean up the title
    if (titleCandidate) {
        // Title case conversion (from ALL CAPS)
        titleCandidate = toTitleCase(titleCandidate);
        // Remove trailing form number if accidentally included
        titleCandidate = titleCandidate.replace(/\s*VA\s*Form\s*\d+.*/i, '').trim();
        // Remove leading/trailing punctuation
        titleCandidate = titleCandidate.replace(/^[-–—:\s]+|[-–—:\s]+$/g, '').trim();
    }

    return titleCandidate || '';
}

/**
 * Convert ALL CAPS to Title Case, preserving common abbreviations
 */
function toTitleCase(str) {
    const preserve = new Set(['VA', 'SSN', 'DOB', 'US', 'USA', 'ID', 'PTSD', 'SMC', 'SMP',
        'POW', 'DD', 'SF', 'OMB', 'RSVP', 'HUD', 'VASH', 'EEO', 'EEOC', 'ADA',
        'HIV', 'AIDS', 'CHAMPVA', 'TRICARE', 'GI', 'VEAP', 'MGIB', 'DEA', 'VR&E',
        'II', 'III', 'IV', 'VI', 'VII', 'VIII', 'IX', 'XI', 'XII']);
    const lowercaseWords = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'for', 'nor',
        'at', 'by', 'in', 'of', 'on', 'to', 'up', 'as', 'is', 'it', 'if', 'so']);

    return str.split(/\s+/).map((word, i) => {
        const upper = word.toUpperCase();
        if (preserve.has(upper)) return upper;
        if (i > 0 && lowercaseWords.has(word.toLowerCase()) && word.length < 4) {
            return word.toLowerCase();
        }
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }).join(' ');
}

/**
 * Extract OMB control number from PDF text
 */
function extractOMB(text) {
    const m = text.match(/OMB\s*(?:Approved\s*(?:No\.?)?|Control\s*(?:No\.?|#)?)\s*[:.]?\s*(\d{4}[-–]\d{4})/i);
    return m ? m[1].replace('–', '-') : '';
}

/**
 * Extract respondent burden estimate from PDF text
 */
function extractBurden(text) {
    // Look for "XX minutes" burden
    const m = text.match(/(?:estimated|average|approximately|respondent)\s*(?:burden|time)[^.]*?(\d+)\s*minutes/i);
    if (m) return `${m[1]} minutes`;

    const m2 = text.match(/(\d+)\s*minutes?\s*(?:per\s+response|to\s+complete|burden)/i);
    if (m2) return `${m2[1]} minutes`;

    return '';
}

/**
 * Extract privacy act statement or instructions from PDF text
 */
function extractInstructions(text, formNumber) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    let instructions = [];
    let inInstructionsBlock = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Look for instruction-like headers
        if (line.match(/^(INSTRUCTIONS|GENERAL\s+INSTRUCTIONS|HOW\s+TO\s+COMPLETE|PURPOSE|IMPORTANT)/i)) {
            inInstructionsBlock = true;
            continue;
        }

        // Look for "purpose of this form" type text
        if (line.match(/(?:purpose|use)\s+(?:of|for)\s+this\s+form/i) && !inInstructionsBlock) {
            inInstructionsBlock = true;
            instructions.push(line);
            continue;
        }

        // Stop at section headers
        if (inInstructionsBlock && line.match(/^(SECTION\s+[IVX]+|PART\s+[IVX]+|[IVX]+\.\s)/i)) {
            break;
        }

        if (inInstructionsBlock && line.length > 20 && !line.match(/^(OMB|VA\s*FORM|Page\s*\d)/i)) {
            instructions.push(line);
            if (instructions.length >= 5) break; // Don't grab too much
        }
    }

    return instructions.join(' ').substring(0, 500).trim();
}

/**
 * Try to detect section structure from field names.
 * Groups fields by common prefixes that suggest sections:
 *   veteransXxx, claimantsXxx, nursingHomeXxx, etc.
 */
function inferSections(properties) {
    const sectionPrefixes = {
        'veteran': "Veteran's Information",
        'claimant': "Claimant's Information",
        'spouse': "Spouse's Information",
        'dependent': "Dependent's Information",
        'employer': "Employer Information",
        'physician': "Physician's Information",
        'doctor': "Doctor's Information",
        'nursing': "Nursing Home Information",
        'hospital': "Hospital Information",
        'insurance': "Insurance Information",
        'service': "Service Information",
        'mailing': "Mailing Address",
        'home': "Home Address",
        'signature': "Certification and Signature",
        'authorization': "Authorization",
        'burial': "Burial Information",
        'death': "Death Information",
    };

    const sections = [];
    const usedFields = new Set();
    const fieldKeys = Object.keys(properties);

    for (const [prefix, title] of Object.entries(sectionPrefixes)) {
        const matching = fieldKeys.filter(k =>
            k.toLowerCase().startsWith(prefix) && !usedFields.has(k)
        );
        if (matching.length >= 2) {
            sections.push({
                title,
                fieldIds: matching
            });
            matching.forEach(k => usedFields.add(k));
        }
    }

    // Remaining fields go into a general section
    const remaining = fieldKeys.filter(k => !usedFields.has(k));
    if (remaining.length > 0) {
        sections.push({
            title: 'Additional Information',
            fieldIds: remaining
        });
    }

    return sections.length > 1 ? sections : []; // Only return if we found meaningful sections
}

// ─── BIO Form Section Mappings (from VA official schemas) ───
const BIO_SECTIONS = {
    '21-0779': {
        formTitle: 'Request for Nursing Home Information in Connection with Claim for Aid and Attendance',
        sections: [
            {
                title: "Section I: Veteran's Identification Information",
                fieldPrefixes: ['veteran', 'vaFileNumber', 'dateOfBirth', 'socialSecurity']
            },
            {
                title: "Section II: Claimant's Identification Information",
                fieldPrefixes: ['claimant']
            },
            {
                title: "Section III: Nursing Home Information",
                fieldPrefixes: ['nursing', 'addressOf', 'nameOfNursing', 'city', 'state', 'zip', 'country', 'apartment']
            },
            {
                title: "Section IV: General Information",
                fieldPrefixes: ['dateOf', 'medicaid', 'monthly', 'certification', 'signature', 'dateSigned']
            }
        ]
    },
    '21-2680': {
        formTitle: 'Examination for Housebound Status or Permanent Need for Regular Aid and Attendance',
        sections: [
            {
                title: "Section I: Veteran's Identification Information",
                fieldPrefixes: ['veteran', 'vaFileNumber', 'lastName', 'middleInitial1']
            },
            {
                title: "Section II: Claimant's Identification Information",
                fieldPrefixes: ['claimant', 'mailingAddress']
            },
            {
                title: "Section III: Claim Information",
                fieldPrefixes: ['benefit', 'claim']
            },
            {
                title: "Section IV: Hospitalization Status",
                fieldPrefixes: ['hospital', 'admission', 'currently']
            },
            {
                title: "Section V: Certification and Signature",
                fieldPrefixes: ['signature', 'dateSigned', 'certif']
            }
        ]
    },
    '21-4192': {
        formTitle: 'Request for Employment Information in Connection with Claim for Disability Benefits',
        sections: [
            {
                title: "Section I: Veteran's Identification",
                fieldPrefixes: ['veteran', 'lastName', 'middleInitial', 'socialSecurity', 'vaFile']
            },
            {
                title: "Section II: Employment Information",
                fieldPrefixes: ['employer', 'nameand', 'completeaddress', 'typeOf', 'dateOf', 'grossamount', 'timeLost', 'concession']
            },
            {
                title: "Section III: Current Status",
                fieldPrefixes: ['reason', 'current', 'thousands', 'hundreds']
            },
            {
                title: "Section IV: Certification",
                fieldPrefixes: ['signature', 'dateSigned', 'certif', 'title']
            }
        ]
    },
    '21P-530a': {
        formTitle: 'Application for Burial Benefits',
        sections: [
            {
                title: "Section I: Veteran Information",
                fieldPrefixes: ['fullName', 'ssn', 'dateOfBirth', 'vaFile', 'serviceNumber']
            },
            {
                title: "Section II: Claimant Information",
                fieldPrefixes: ['address', 'phoneNumber', 'claimant']
            },
            {
                title: "Section III: Burial and Service Information",
                fieldPrefixes: ['dateOfBurial', 'dateOfDeath', 'dateEntered', 'dateLeft', 'placeLeft', 'branch']
            },
            {
                title: "Section IV: Certification",
                fieldPrefixes: ['dateSigned', 'signature']
            }
        ]
    }
};

/**
 * Map BIO section definitions to actual form sections with field IDs
 */
function mapBIOSections(formNumber, properties) {
    const bioConfig = BIO_SECTIONS[formNumber];
    if (!bioConfig) return null;

    const fieldKeys = Object.keys(properties);
    const usedFields = new Set();
    const sections = [];

    for (const secDef of bioConfig.sections) {
        const fieldIds = [];
        for (const prefix of secDef.fieldPrefixes) {
            for (const key of fieldKeys) {
                if (!usedFields.has(key) && key.toLowerCase().startsWith(prefix.toLowerCase())) {
                    fieldIds.push(key);
                    usedFields.add(key);
                }
            }
        }
        if (fieldIds.length > 0) {
            sections.push({
                title: secDef.title,
                rows: fieldIds.map(id => ({
                    columns: [{ fieldId: id, width: 12 }]
                }))
            });
        }
    }

    // Any remaining fields
    const remaining = fieldKeys.filter(k => !usedFields.has(k));
    if (remaining.length > 0) {
        sections.push({
            title: 'Additional Information',
            rows: remaining.map(id => ({
                columns: [{ fieldId: id, width: 12 }]
            }))
        });
    }

    return { formTitle: bioConfig.formTitle, sections };
}

// ─── Main processing ───
async function processSchema(filepath, dryRun = false) {
    let schema;
    try {
        schema = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    } catch (e) {
        console.log(`  ERROR: Cannot read ${filepath}: ${e.message}`);
        return false;
    }

    const formNumber = schema.title || path.basename(filepath, '.json');
    const meta = schema['x-va-metadata'] || {};
    const pdfUrl = meta.formUrl || '';
    const properties = schema.properties || {};

    if (!properties || Object.keys(properties).length === 0) return false;

    // Check if this is a BIO form
    const bioData = mapBIOSections(formNumber, properties);

    let formTitle = bioData ? bioData.formTitle : '';
    let ombNumber = '';
    let respondentBurden = '';
    let instructions = '';
    let formSections = bioData ? bioData.sections : [];

    // Try to extract metadata from PDF
    if (pdfUrl) {
        try {
            const pdfBuffer = await downloadPDF(pdfUrl);
            const pdfParse = require('pdf-parse');
            const data = await pdfParse(pdfBuffer, { max: 3 }); // Only first 3 pages
            const text = data.text || '';

            if (!formTitle) {
                formTitle = extractFormTitle(text, formNumber);
            }
            ombNumber = extractOMB(text);
            respondentBurden = extractBurden(text);
            if (!instructions) {
                instructions = extractInstructions(text, formNumber);
            }
        } catch (e) {
            console.log(`  WARNING: Could not download/parse PDF for ${formNumber}: ${e.message}`);
        }
    }

    // If still no title, try to derive from form number
    if (!formTitle) {
        formTitle = `VA Form ${formNumber}`;
    }

    // Build x-va-form
    const vaForm = {};
    vaForm.formNumber = formNumber;
    vaForm.formTitle = formTitle;
    if (ombNumber) vaForm.ombNumber = ombNumber;
    if (respondentBurden) vaForm.respondentBurden = respondentBurden;
    if (instructions) vaForm.instructions = instructions;
    if (formSections.length > 0) vaForm.formSections = formSections;

    // If no BIO sections, try to infer sections from field names
    if (formSections.length === 0) {
        const inferred = inferSections(properties);
        if (inferred.length > 0) {
            vaForm.formSections = inferred.map(sec => ({
                title: sec.title,
                rows: sec.fieldIds.map(id => ({
                    columns: [{ fieldId: id, width: 12 }]
                }))
            }));
        }
    }

    if (dryRun) {
        console.log(`  [DRY RUN] ${formNumber}: title="${formTitle}", OMB=${ombNumber || 'none'}, burden=${respondentBurden || 'none'}, instructions=${instructions ? instructions.substring(0, 60) + '...' : 'none'}, sections=${(vaForm.formSections || []).length}`);
        return true;
    }

    // Write back
    schema['x-va-form'] = vaForm;
    fs.writeFileSync(filepath, JSON.stringify(schema, null, 2));
    console.log(`  ENRICHED ${formNumber}: "${formTitle}" (${(vaForm.formSections || []).length} sections)`);
    return true;
}

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const formFlag = args.indexOf('--form');
    const targetForm = formFlag >= 0 ? args[formFlag + 1] : null;
    const bioOnly = args.includes('--bio-only');

    console.log('='.repeat(70));
    console.log('VA Form Schema Enrichment');
    console.log('='.repeat(70));
    if (dryRun) console.log('[DRY RUN MODE — no files will be modified]');
    console.log();

    // Collect all schema files
    const schemaFiles = [];
    function walkDir(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                walkDir(path.join(dir, entry.name));
            } else if (entry.name.endsWith('.json') && entry.name !== 'index.json') {
                schemaFiles.push(path.join(dir, entry.name));
            }
        }
    }
    walkDir(SCHEMAS_DIR);

    let processed = 0, enriched = 0, errors = 0;

    // Process with concurrency limit to avoid overwhelming the network
    const CONCURRENCY = 5;
    const bioForms = new Set(['21-0779', '21-2680', '21-4192', '21P-530a']);

    for (let i = 0; i < schemaFiles.length; i += CONCURRENCY) {
        const batch = schemaFiles.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(batch.map(async (filepath) => {
            const basename = path.basename(filepath, '.json');

            // Filter
            if (targetForm && basename !== targetForm) return false;
            if (bioOnly && !bioForms.has(basename)) return false;

            processed++;
            try {
                return await processSchema(filepath, dryRun);
            } catch (e) {
                console.log(`  ERROR processing ${basename}: ${e.message}`);
                errors++;
                return false;
            }
        }));

        for (const r of results) {
            if (r.status === 'fulfilled' && r.value) enriched++;
        }
    }

    console.log();
    console.log('='.repeat(70));
    console.log('ENRICHMENT SUMMARY');
    console.log('='.repeat(70));
    console.log(`Schemas processed: ${processed}`);
    console.log(`Schemas enriched:  ${enriched}`);
    console.log(`Errors:            ${errors}`);
}

main().catch(e => {
    console.error('FATAL:', e);
    process.exit(1);
});
