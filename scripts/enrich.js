#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// ============================================================================
// Configuration and Constants
// ============================================================================

const ORG_MAP = {
  '20': { org: 'vba', path: 'schemas/vba' },
  '21': { org: 'vba', path: 'schemas/vba' },
  '21P': { org: 'vba', path: 'schemas/vba' },
  '22': { org: 'vba', path: 'schemas/vba' },
  '26': { org: 'vba', path: 'schemas/vba' },
  '27': { org: 'vba', path: 'schemas/vba' },
  '28': { org: 'vba', path: 'schemas/vba' },
  '29': { org: 'vba', path: 'schemas/vba' },
  '10': { org: 'vha', path: 'schemas/va/vha' },
  '40': { org: 'nca', path: 'schemas/va/nca' },
  'VA40': { org: 'nca', path: 'schemas/va/nca' },
  'SF': { org: 'admin', path: 'schemas/va/admin' },
};

const WIDGET_PATTERNS = {
  ssn: /\bssn\b|\bsocial.?security\b|\bss#\b/i,
  date: /\b(dob|birth|date|effective|expiration|submission)\b/i,
  'state-select': /\bstate\b|\bprovince\b/i,
  phone: /\bphone\b|\btelephon\b/i,
  'radio-yesno': /\b(yes|no|applicable|required)\b.*(?:field|answer)/i,
  address: /\baddress\b|\bstreet\b|\bcity\b|\bzip\b/i,
};

const VA_WIDGET_TYPES = [
  'text',
  'textarea',
  'email',
  'phone',
  'ssn',
  'date',
  'select',
  'state-select',
  'checkbox',
  'radio',
  'radio-yesno',
  'address',
  'number',
];

// ============================================================================
// Logging Utilities
// ============================================================================

const log = {
  info: (msg) => console.log(`[INFO] ${msg}`),
  warn: (msg) => console.warn(`[WARN] ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`),
  success: (msg) => console.log(`[SUCCESS] ${msg}`),
  debug: (msg) => {
    if (process.env.DEBUG) console.log(`[DEBUG] ${msg}`);
  },
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Detect organization and schema path from form number
 */
function detectOrg(formNumber) {
  for (const [prefix, info] of Object.entries(ORG_MAP)) {
    if (formNumber.startsWith(prefix)) {
      return { formNumber, ...info };
    }
  }
  throw new Error(`Unable to detect org for form number: ${formNumber}`);
}

/**
 * Extract metadata from existing schema structure
 */
function extractMetadata(schema) {
  const metadata = {
    title: schema.title || '',
    description: schema.description || '',
    ombNumber: null,
    burden: null,
    formNumber: null,
  };

  // Try to extract OMB number from title or description
  const ombMatch = (schema.title || schema.description || '').match(/OMB\s+(\d{4}-\d{4})/i);
  if (ombMatch) {
    metadata.ombNumber = ombMatch[1];
  }

  // Try to extract burden from properties
  if (schema.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (prop.description && prop.description.includes('burden')) {
        const burdenMatch = prop.description.match(/(\d+)\s*(?:hours?|minutes?)/i);
        if (burdenMatch) {
          metadata.burden = burdenMatch[1];
        }
      }
    }
  }

  return metadata;
}

/**
 * Auto-group fields into sections based on page/prefix patterns
 */
function autoGroupSections(fields) {
  const sections = [];
  const seenPrefixes = new Set();

  for (const field of fields) {
    const nameParts = field.name.split('_');
    const prefix = nameParts[0];

    if (!seenPrefixes.has(prefix)) {
      seenPrefixes.add(prefix);
      sections.push({
        id: prefix.toLowerCase(),
        title: humanizeTitle(prefix),
        description: '',
        fields: [],
      });
    }

    const section = sections[sections.length - 1];
    if (section.fields.length === 0 || section.fields[section.fields.length - 1].name.startsWith(prefix)) {
      section.fields.push(field);
    } else {
      const newSection = {
        id: `${prefix.toLowerCase()}_${sections.length}`,
        title: humanizeTitle(prefix),
        description: '',
        fields: [field],
      };
      sections.push(newSection);
    }
  }

  return sections;
}

/**
 * Convert machine names to human-readable titles
 */
function humanizeTitle(str) {
  return str
    .split(/[_-]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Map field types to VA widget types
 */
function mapWidgets(fields) {
  return fields.map((field) => {
    let widget = field.type === 'string' ? 'text' : field.type;

    // Apply pattern-based widget mapping
    for (const [widgetType, pattern] of Object.entries(WIDGET_PATTERNS)) {
      if (pattern.test(field.name) || pattern.test(field.description || '')) {
        widget = widgetType;
        break;
      }
    }

    return {
      ...field,
      'x-va-field': {
        widget,
        label: field.title || humanizeTitle(field.name),
        required: field.required === true,
        hint: field.description || '',
      },
    };
  });
}

/**
 * Build AI enrichment prompt
 */
function buildEnrichmentPrompt(schema) {
  const fieldsJson = JSON.stringify(schema.properties, null, 2);
  return `You are a VA form digitization expert. Analyze this form schema and provide enrichment suggestions in valid JSON format.

Form Title: ${schema.title || 'Unknown'}
Form Number: ${schema.properties?.formNumber?.default || 'Not found'}

Current Fields:
${fieldsJson}

Provide a JSON object with this structure:
{
  "sections": [
    {
      "id": "section_id",
      "title": "Human-Readable Section Title",
      "description": "What this section is about",
      "fields": ["field_name_1", "field_name_2"]
    }
  ],
  "fieldEnhancements": {
    "field_name": {
      "label": "Human-readable label",
      "hint": "Helpful hint for the user",
      "widget": "one of: text, textarea, email, phone, ssn, date, select, state-select, checkbox, radio, radio-yesno, address, number",
      "required": true/false,
      "validation": "validation rule if applicable"
    }
  },
  "sectionInstructions": {
    "section_id": "Step-by-step instructions for completing this section"
  }
}

Focus on:
1. Converting field names like TEXTFIELD_23 into descriptive labels
2. Grouping logically related fields
3. Identifying required vs optional fields
4. Mapping to appropriate VA widget types
5. Adding helpful instructions and hints

Return ONLY valid JSON, no markdown or explanations.`;
}

/**
 * Call AI API for enrichment
 */
async function enrichWithAI(schema, provider, model, apiKey) {
  if (!apiKey) {
    log.warn('No API key provided, skipping AI enrichment');
    return null;
  }

  const prompt = buildEnrichmentPrompt(schema);

  try {
    let response;

    if (provider === 'anthropic') {
      response = await callAnthropicAPI(prompt, model, apiKey);
    } else if (provider === 'openai') {
      response = await callOpenAIAPI(prompt, model, apiKey);
    } else if (provider === 'google') {
      response = await callGoogleAPI(prompt, model, apiKey);
    } else if (provider === 'ollama') {
      response = await callOllamaAPI(prompt, model);
    } else if (provider === 'custom') {
      response = await callCustomAPI(prompt, model, apiKey);
    } else {
      throw new Error(`Unknown AI provider: ${provider}`);
    }

    log.debug(`AI Response: ${response}`);

    try {
      return JSON.parse(response);
    } catch (e) {
      log.warn(`Failed to parse AI response as JSON: ${e.message}`);
      return null;
    }
  } catch (error) {
    log.error(`AI enrichment failed: ${error.message}`);
    return null;
  }
}

/**
 * Call Anthropic API
 */
async function callAnthropicAPI(prompt, model, apiKey) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.content[0].text;
}

/**
 * Call OpenAI API
 */
async function callOpenAIAPI(prompt, model, apiKey) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

/**
 * Call Google Generative AI API
 */
async function callGoogleAPI(prompt, model, apiKey) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: prompt,
              },
            ],
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Google API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.candidates[0].content.parts[0].text;
}

/**
 * Call Ollama API (local)
 */
async function callOllamaAPI(prompt, model) {
  const response = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      stream: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.message.content;
}

/**
 * Call custom OpenAI-compatible API
 */
async function callCustomAPI(prompt, model, apiKey) {
  const baseUrl = process.env.AI_API_BASE || 'http://localhost:8000';
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Custom API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

/**
 * Merge AI enrichment into schema
 */
function mergeAIEnrichment(schema, aiEnrichment) {
  if (!aiEnrichment) return schema;

  const enriched = { ...schema };

  // Apply field enhancements
  if (aiEnrichment.fieldEnhancements && enriched.properties) {
    for (const [fieldName, enhancement] of Object.entries(aiEnrichment.fieldEnhancements)) {
      if (enriched.properties[fieldName]) {
        enriched.properties[fieldName] = {
          ...enriched.properties[fieldName],
          title: enhancement.label || enriched.properties[fieldName].title,
          description: enhancement.hint || enriched.properties[fieldName].description,
          'x-va-field': {
            widget: enhancement.widget,
            label: enhancement.label,
            required: enhancement.required !== false,
            hint: enhancement.hint || '',
            validation: enhancement.validation,
          },
        };
      }
    }
  }

  // Store sections and instructions
  enriched['x-va-form'] = enriched['x-va-form'] || {};
  if (aiEnrichment.sections) {
    enriched['x-va-form'].formSections = aiEnrichment.sections;
  }
  if (aiEnrichment.sectionInstructions) {
    enriched['x-va-form'].sectionInstructions = aiEnrichment.sectionInstructions;
  }

  return enriched;
}

/**
 * Enrich schema with VA metadata
 */
async function enrichSchema(schema, options = {}) {
  const formNumber = schema.properties?.formNumber?.default || schema.title?.match(/\d{2}-\d{4}/)?.[0];

  if (!formNumber) {
    throw new Error('Unable to determine form number from schema');
  }

  const orgInfo = detectOrg(formNumber);
  const metadata = extractMetadata(schema);

  let enriched = {
    ...schema,
    'x-va-form': {
      formNumber,
      org: orgInfo.org,
      ...metadata,
    },
  };

  // Add widget mappings
  if (enriched.properties) {
    const enrichedProps = {};
    for (const [key, prop] of Object.entries(enriched.properties)) {
      enrichedProps[key] = {
        ...prop,
        'x-va-field': {
          widget: prop.type === 'string' ? 'text' : prop.type,
          label: prop.title || humanizeTitle(key),
          required: prop.required === true,
          hint: prop.description || '',
        },
      };

      // Apply pattern-based widget mapping
      for (const [widgetType, pattern] of Object.entries(WIDGET_PATTERNS)) {
        if (pattern.test(key) || pattern.test(prop.description || '')) {
          enrichedProps[key]['x-va-field'].widget = widgetType;
          break;
        }
      }
    }
    enriched.properties = enrichedProps;
  }

  // Apply AI enrichment if requested
  if (options.useAI) {
    const aiEnrichment = await enrichWithAI(enriched, options.provider, options.model, options.apiKey);
    enriched = mergeAIEnrichment(enriched, aiEnrichment);
  }

  return { enriched, orgInfo };
}

/**
 * Save enriched schema and update index
 */
function saveSchema(enrichedSchema, orgInfo) {
  const schemaDir = path.join(process.cwd(), orgInfo.path);
  const indexPath = path.join(schemaDir, 'index.json');
  const schemaPath = path.join(schemaDir, `${orgInfo.formNumber}.json`);

  // Ensure directory exists
  if (!fs.existsSync(schemaDir)) {
    fs.mkdirSync(schemaDir, { recursive: true });
    log.info(`Created directory: ${schemaDir}`);
  }

  // Write schema file
  fs.writeFileSync(schemaPath, JSON.stringify(enrichedSchema, null, 2));
  log.success(`Saved schema to: ${schemaPath}`);

  // Update index
  let index = { forms: [] };
  if (fs.existsSync(indexPath)) {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  }

  const fieldCount = Object.keys(enrichedSchema.properties || {}).length;
  const pageCount = enrichedSchema['x-va-form']?.pageCount || 1;
  const mappedCount = enrichedSchema['x-va-form']?.mappedFieldCount || fieldCount;

  const existingIndex = index.forms.findIndex((f) => f.formNumber === orgInfo.formNumber);
  const entry = {
    file: `${orgInfo.formNumber}.json`,
    formNumber: orgInfo.formNumber,
    title: enrichedSchema.title || orgInfo.formNumber,
    fields: fieldCount,
    pages: pageCount,
    mapped: mappedCount,
  };

  if (existingIndex >= 0) {
    index.forms[existingIndex] = entry;
  } else {
    index.forms.push(entry);
  }

  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  log.success(`Updated index: ${indexPath}`);
}

/**
 * Parse command-line arguments
 */
function parseArgs() {
  const args = {
    input: null,
    useAI: false,
    provider: process.env.AI_PROVIDER || 'anthropic',
    model: process.env.AI_MODEL || 'claude-sonnet-4-20250514',
    apiKey: process.env.AI_API_KEY || null,
  };

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];

    if (arg === '--input' && process.argv[i + 1]) {
      args.input = process.argv[++i];
    } else if (arg === '--ai') {
      args.useAI = true;
    } else if (arg === '--provider' && process.argv[i + 1]) {
      args.provider = process.argv[++i];
    } else if (arg === '--model' && process.argv[i + 1]) {
      args.model = process.argv[++i];
    } else if (arg === '--api-key' && process.argv[i + 1]) {
      args.apiKey = process.argv[++i];
    }
  }

  return args;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  try {
    const args = parseArgs();

    if (!args.input) {
      throw new Error('--input is required');
    }

    if (!fs.existsSync(args.input)) {
      throw new Error(`Input file not found: ${args.input}`);
    }

    log.info(`Loading schema from: ${args.input}`);
    const schema = JSON.parse(fs.readFileSync(args.input, 'utf-8'));

    log.info('Enriching schema...');
    const { enriched, orgInfo } = await enrichSchema(schema, {
      useAI: args.useAI,
      provider: args.provider,
      model: args.model,
      apiKey: args.apiKey,
    });

    log.info(`Detected org: ${orgInfo.org} (${orgInfo.path})`);
    log.info(`Form number: ${orgInfo.formNumber}`);

    log.info('Saving schema...');
    saveSchema(enriched, orgInfo);

    log.success('Enrichment complete!');
  } catch (error) {
    log.error(error.message);
    process.exit(1);
  }
}

main();
