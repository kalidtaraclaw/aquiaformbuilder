(function() {
  'use strict';

  let stopped = false;
  const MAX_CONCURRENT = 3;
  const TIMEOUT_MS = 30000;

  window._vbaSchemas = {};
  window._vbaProgress = { processed: 0, total: 0, current: null, errors: [] };

  // ─── Load pdf-lib ───
  function ensurePdfLib() {
    return new Promise((resolve) => {
      if (window.PDFLib) return resolve();
      const s = document.createElement('script');
      s.src = 'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js';
      s.onload = resolve;
      s.onerror = () => { console.error('Failed to load pdf-lib'); resolve(); };
      document.head.appendChild(s);
    });
  }

  // ─── 24 Composition Patterns ───
  const patterns = {
    ssn: (fs) => fs.filter(f =>
      /ssn|social.*security|ss\s*#|soc.*sec/i.test(f.label) || /ssn/i.test(f.id)),
    dob: (fs) => fs.filter(f =>
      /date.*birth|birth.*date|d\.?o\.?b|born/i.test(f.label) || /dob/i.test(f.id)),
    fullName: (fs) => fs.filter(f =>
      /^(first|middle|last|suffix)[\s_]?name?$/i.test(f.label) ||
      /first.*name|middle.*name|last.*name|suffix/i.test(f.label) ||
      /first_name|last_name|middle_name|middle_initial|firstname|lastname|middlename/i.test(f.label) ||
      /veterans?_?(first|last|middle)|claimant_?(first|last|middle)|beneficiary_?(first|last|middle)/i.test(f.label) ||
      /firstmiddlelast/i.test(f.label) ||
      /(first|middle|last|suffix)/i.test(f.id)),
    address: (fs) => fs.filter(f =>
      /street|address|city|state|zip|postal|country|apt|unit|county|mailing|residence/i.test(f.label) ||
      /street|addr|city|state|zip|postal|country/i.test(f.id)),
    phone: (fs) => fs.filter(f =>
      /phone|telephone|fax|mobile|cell/i.test(f.label) || /phone|tel|fax/i.test(f.id)),
    email: (fs) => fs.filter(f =>
      /email|e-mail/i.test(f.label) || /email/i.test(f.id)),
    vaFileNumber: (fs) => fs.filter(f =>
      /va[\s_]*file|file[\s_]*number|c[\s_-]*file|c[\s_-]*number|claim[\s_]*number/i.test(f.label) ||
      /va_file|file_number|claim_number/i.test(f.id)),
    serviceNumber: (fs) => fs.filter(f =>
      /service[\s_]*number|service[\s_]*#|military[\s_]*id/i.test(f.label) ||
      /service_number|service_num/i.test(f.id)),
    remarks: (fs) => fs.filter(f =>
      /\b(remark|comment|explanation|limitation|narrative|additional[\s_]*info|specify|describe)\b/i.test(f.label)),
    financial: (fs) => fs.filter(f =>
      /income|asset|expense|debt|net[\s_]*worth|bank|account[\s_]*balance|salary|wage|amount|percentage|lump[\s_]*sum|total[\s_]*amount/i.test(f.label) ||
      /income|financial|amount/i.test(f.id)),
    date: (fs) => fs.filter(f =>
      (/\bdate\b|datefield|date_of|mm[\s_]*dd|dd[\s_]*mm|month[\s_]*year/i.test(f.label) ||
       /date/i.test(f.id)) && !/birth|dob/i.test(f.label)),
    signature: (fs) => fs.filter(f =>
      /signature|sign|autograph|certif|attest|witness/i.test(f.label)),
    checkbox: (fs) => fs.filter(f =>
      f.type === 'checkbox' || /check|yes[\s_]*no|true[\s_]*false/i.test(f.label)),
    radio: (fs) => fs.filter(f =>
      f.type === 'radio' || /radio|choice|option|select/i.test(f.label)),
    dependent: (fs) => fs.filter(f =>
      /dependent|child|minor|custody|spouse|marital|marriage|guardian/i.test(f.label)),
    insurance: (fs) => fs.filter(f =>
      /insurance|policy|group[\s_]*number|plan[\s_]*name|premium|coverage/i.test(f.label)),
    medical: (fs) => fs.filter(f =>
      /diagnosis|treatment|condition|symptom|medication|doctor|physician|hospital|clinic|icd|medical|disability/i.test(f.label)),
    employer: (fs) => fs.filter(f =>
      /employer|company|business|occupation|job[\s_]*title|work|supervisor/i.test(f.label)),
    relationship: (fs) => fs.filter(f =>
      /relationship|relation[\s_]*to|related/i.test(f.label)),
    documentType: (fs) => fs.filter(f =>
      /certificate|decree|court[\s_]*paper|personnel[\s_]*record|birth[\s_]*cert|death[\s_]*cert|marriage[\s_]*cert|divorce/i.test(f.label)),
    education: (fs) => fs.filter(f =>
      /school|training|education|course|degree|institution|university|college/i.test(f.label)),
    physicalDesc: (fs) => fs.filter(f =>
      /\b(height|weight|gender|sex|race|hair|eyes|complexion)\b/i.test(f.label)),
    military: (fs) => fs.filter(f =>
      /\b(branch|rank|grade|discharge|duty|active[\s_]*service|veteran|enlist|separation|campaign|theater|deployed)\b/i.test(f.label) &&
      !/service[\s_]*number/i.test(f.label))
  };

  // ─── Label Cleaning ───
  function cleanFieldLabel(raw) {
    if (!raw || raw.length === 0) return raw;
    let label = raw;
    label = label.replace(/^\d+[a-z]?\.\s*/i, '');
    label = label.replace(/[\.\-\s]+$/, '');
    label = label.replace(/^(please\s+)?(enter|provide|give|specify|type|input|indicate|list|state)\s+(your\s+|the\s+)?/i, '');
    label = label.replace(/\s*[-–]\s*(enter|type|please|format|use)\s.*$/i, '');
    label = label.replace(/\s*\(?(enter|type|please|format|use)\s[^)]*\)?\s*$/i, '');
    label = label.replace(/[\.\-\s]+$/, '');
    label = label.replace(/\[\d+\]/g, '');
    label = label.replace(/\s+/g, ' ').trim();
    if (label === label.toUpperCase() && label.length > 3) {
      label = label.replace(/\b\w+/g, w =>
        w.length <= 2 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
      );
    }
    if (label.length > 0) label = label.charAt(0).toUpperCase() + label.slice(1);
    return label;
  }

  function humanizeFieldName(name) {
    let label = name.split('.').pop();
    label = label.replace(/\[\d+\]/g, '');
    label = label.replace(/([a-z])([A-Z])/g, '$1 $2');
    label = label.replace(/[_-]/g, ' ');
    label = label.replace(/\b\w/g, c => c.toUpperCase());
    return label.trim();
  }

  function isGenericFieldName(name) {
    if (!name) return true;
    const leaf = name.split('.').pop().replace(/\[\d+\]$/, '');
    return /^(TextField|DateTimeField|NumericField|Button|ImageField|#field)\d*$/i.test(leaf);
  }

  function labelToPropertyName(label) {
    if (!label) return '';
    return label
      .replace(/^\d+[a-z]?\.\s+/i, '')
      .replace(/[^\w\s]/g, '')
      .trim()
      .split(/\s+/)
      .map((w, i) => i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join('');
  }

  // ─── XFA Label Extraction (validated working version) ───
  async function extractXFALabels(uint8Array) {
    const labels = {};
    try {
      const pdfDoc = await PDFLib.PDFDocument.load(uint8Array, { ignoreEncryption: true });
      const catalog = pdfDoc.catalog;
      const acroFormDict = catalog.lookup(PDFLib.PDFName.of('AcroForm'));
      if (!acroFormDict) return labels;

      const xfa = acroFormDict.lookup(PDFLib.PDFName.of('XFA'));
      if (!xfa) return labels;

      // Find the "template" entry in the XFA array
      let templateEntry = null;
      if (typeof xfa.asArray === 'function') {
        const arr = xfa.asArray();
        for (let i = 0; i < arr.length - 1; i++) {
          const entry = arr[i];
          let name = null;
          if (entry && typeof entry.asString === 'function') name = entry.asString();
          else if (entry && typeof entry.decodeText === 'function') name = entry.decodeText();
          if (name === 'template') { templateEntry = arr[i + 1]; break; }
        }
      }
      if (!templateEntry) return labels;

      // Resolve PDFRef → actual stream object
      let stream = templateEntry;
      if (typeof stream.getContents !== 'function' && pdfDoc.context) {
        stream = pdfDoc.context.lookup(templateEntry);
      }
      if (!stream || typeof stream.getContents !== 'function') return labels;

      const rawBytes = stream.getContents();
      if (!rawBytes || rawBytes.length === 0) return labels;

      // Decompress FlateDecode
      let xmlText = '';
      try {
        const ds = new DecompressionStream('deflate');
        const writer = ds.writable.getWriter();
        writer.write(rawBytes);
        writer.close();
        const reader = ds.readable.getReader();
        const chunks = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const totalLen = chunks.reduce((s, c) => s + c.length, 0);
        const merged = new Uint8Array(totalLen);
        let off = 0;
        for (const c of chunks) { merged.set(c, off); off += c.length; }
        xmlText = new TextDecoder().decode(merged);
      } catch (e) {
        xmlText = new TextDecoder().decode(rawBytes);
      }

      if (!xmlText || xmlText.length === 0) return labels;

      // Parse with DOMParser
      const parser = new DOMParser();
      const doc = parser.parseFromString(xmlText, 'text/xml');
      const fields = doc.querySelectorAll('field');
      for (const field of fields) {
        const name = field.getAttribute('name');
        if (!name) continue;
        const assist = field.querySelector('assist');
        if (assist) {
          const toolTip = assist.querySelector('toolTip');
          if (toolTip && toolTip.textContent.trim()) {
            labels[name] = toolTip.textContent.trim();
            continue;
          }
        }
        const caption = field.querySelector('caption');
        if (caption) {
          const text = caption.querySelector('value > text');
          if (text && text.textContent.trim()) {
            labels[name] = text.textContent.trim();
          }
        }
      }
    } catch (e) {
      console.warn('XFA extraction failed:', e.message);
    }
    return labels;
  }

  // ─── Extract fields from PDF (AcroForm + XFA) ───
  async function extractFields(uint8Array) {
    const fields = [];
    try {
      const pdfDoc = await PDFLib.PDFDocument.load(uint8Array, { ignoreEncryption: true });
      const xfaLabels = await extractXFALabels(uint8Array);
      const hasXFA = Object.keys(xfaLabels).length > 0;

      const form = pdfDoc.getForm();
      const pdfFields = form.getFields();

      for (const field of pdfFields) {
        const rawName = field.getName();
        const fieldType = field.constructor.name.replace('PDF', '').replace('Field', '').toLowerCase();
        const isGeneric = isGenericFieldName(rawName);

        // Determine best label
        let label = rawName;
        let source = 'acroform';
        const leafName = rawName.split('.').pop().replace(/\[\d+\]$/, '');
        const xfaLabel = xfaLabels[rawName] || xfaLabels[leafName];

        if (xfaLabel) {
          label = cleanFieldLabel(xfaLabel);
          source = 'xfa';
        } else if (!isGeneric) {
          label = cleanFieldLabel(humanizeFieldName(rawName));
        }

        const needsReview = isGeneric && !xfaLabel;

        fields.push({
          id: rawName,
          label: label,
          type: fieldType === 'check' ? 'checkbox' : fieldType === 'optionlist' || fieldType === 'dropdown' ? 'select' : fieldType,
          source: source,
          needsReview: needsReview
        });
      }

      return { fields, xfaLabelCount: Object.keys(xfaLabels).length, pageCount: pdfDoc.getPageCount() };
    } catch (e) {
      throw new Error('Field extraction failed: ' + e.message);
    }
  }

  // ─── Schema Generation ───
  function generateSchema(formName, formUrl, fields, xfaLabelCount) {
    const consumed = new Set();
    const properties = {};
    const required = [];

    // Run composition patterns in priority order
    // 1. SSN
    const ssns = patterns.ssn(fields.filter(f => !consumed.has(f.id)));
    if (ssns.length >= 1) {
      properties.ssn = { type: 'string', pattern: '^\\d{3}-?\\d{2}-?\\d{4}$', maxLength: 11 };
      required.push('ssn');
      ssns.forEach(f => consumed.add(f.id));
    }

    // 2. Date of Birth
    const dobs = patterns.dob(fields.filter(f => !consumed.has(f.id)));
    if (dobs.length >= 1) {
      properties.dateOfBirth = { type: 'string', format: 'date' };
      dobs.forEach(f => consumed.add(f.id));
    }

    // 3. Full Name
    const names = patterns.fullName(fields.filter(f => !consumed.has(f.id)));
    if (names.length >= 2) {
      properties.fullName = {
        type: 'object',
        properties: {
          first: { type: 'string', maxLength: 30 },
          middle: { type: ['string', 'null'], maxLength: 30 },
          last: { type: 'string', maxLength: 30 },
          suffix: { type: ['string', 'null'], maxLength: 10 }
        },
        required: ['first', 'last']
      };
      required.push('fullName');
      names.forEach(f => consumed.add(f.id));
    }

    // 4. Address
    const addrs = patterns.address(fields.filter(f => !consumed.has(f.id)));
    if (addrs.length >= 2) {
      properties.address = {
        type: 'object',
        properties: {
          street: { type: 'string', maxLength: 50 },
          street2: { type: ['string', 'null'], maxLength: 50 },
          city: { type: 'string', maxLength: 30 },
          state: { type: 'string', maxLength: 2 },
          postalCode: { type: 'string', maxLength: 10 },
          country: { type: ['string', 'null'], maxLength: 30 }
        },
        required: ['street', 'city', 'state', 'postalCode']
      };
      addrs.forEach(f => consumed.add(f.id));
    }

    // 5. Phone
    const phones = patterns.phone(fields.filter(f => !consumed.has(f.id)));
    if (phones.length >= 1) {
      properties.phoneNumber = { type: 'string', pattern: '^\\d{10}$', maxLength: 10 };
      phones.forEach(f => consumed.add(f.id));
    }

    // 6. Email
    const emails = patterns.email(fields.filter(f => !consumed.has(f.id)));
    if (emails.length >= 1) {
      properties.email = { type: 'string', format: 'email' };
      emails.forEach(f => consumed.add(f.id));
    }

    // 7. VA File Number
    const vaFiles = patterns.vaFileNumber(fields.filter(f => !consumed.has(f.id)));
    if (vaFiles.length >= 1) {
      properties.vaFileNumber = { type: ['string', 'null'], maxLength: 9 };
      vaFiles.forEach(f => consumed.add(f.id));
    }

    // 8. Service Number
    const svcNums = patterns.serviceNumber(fields.filter(f => !consumed.has(f.id)));
    if (svcNums.length >= 1) {
      properties.serviceNumber = { type: ['string', 'null'] };
      svcNums.forEach(f => consumed.add(f.id));
    }

    // 9. Date fields
    const dates = patterns.date(fields.filter(f => !consumed.has(f.id)));
    dates.forEach(f => {
      const propName = labelToPropertyName(f.label) || 'date_' + f.id.replace(/[^a-zA-Z0-9]/g, '_');
      properties[propName] = { type: 'string', format: 'date' };
      consumed.add(f.id);
    });

    // 10. Signature
    const sigs = patterns.signature(fields.filter(f => !consumed.has(f.id)));
    if (sigs.length >= 1) {
      properties.signature = { type: 'boolean', description: 'Veteran/claimant signature certification' };
      sigs.forEach(f => consumed.add(f.id));
    }

    // 11. Checkboxes
    const checks = patterns.checkbox(fields.filter(f => !consumed.has(f.id)));
    checks.forEach(f => {
      const propName = labelToPropertyName(f.label) || 'checkbox_' + f.id.replace(/[^a-zA-Z0-9]/g, '_');
      properties[propName] = { type: 'boolean' };
      consumed.add(f.id);
    });

    // 12. Radio
    const radios = patterns.radio(fields.filter(f => !consumed.has(f.id)));
    radios.forEach(f => {
      const propName = labelToPropertyName(f.label) || 'selection_' + f.id.replace(/[^a-zA-Z0-9]/g, '_');
      properties[propName] = { type: 'string' };
      consumed.add(f.id);
    });

    // 13-23. Other semantic patterns
    const otherPatterns = [
      { key: 'financial', type: 'number' },
      { key: 'medical', type: 'string' },
      { key: 'dependent', type: 'string' },
      { key: 'insurance', type: 'string' },
      { key: 'employer', type: 'string' },
      { key: 'relationship', type: 'string' },
      { key: 'documentType', type: 'string' },
      { key: 'education', type: 'string' },
      { key: 'physicalDesc', type: 'string' },
      { key: 'remarks', type: 'string' },
      { key: 'military', type: 'string' }
    ];

    otherPatterns.forEach(({ key, type }) => {
      const matched = patterns[key](fields.filter(f => !consumed.has(f.id)));
      matched.forEach(f => {
        const propName = labelToPropertyName(f.label) || key + '_' + f.id.replace(/[^a-zA-Z0-9]/g, '_');
        properties[propName] = { type };
        consumed.add(f.id);
      });
    });

    // Remaining unconsumed fields
    let needsReviewCount = 0;
    fields.forEach(f => {
      if (consumed.has(f.id)) return;
      const propName = labelToPropertyName(f.label) || 'field_' + f.id.replace(/[^a-zA-Z0-9]/g, '_');
      const prop = { type: 'string' };
      if (f.needsReview) {
        prop['x-needs-review'] = true;
        needsReviewCount++;
      }
      properties[propName] = prop;
    });

    const composedCount = consumed.size;
    const coveragePct = fields.length > 0 ? Math.round((composedCount / fields.length) * 100) : 0;

    return {
      $schema: 'http://json-schema.org/draft-07/schema#',
      title: formName,
      type: 'object',
      required: required.length > 0 ? required : undefined,
      properties,
      'x-va-metadata': {
        formUrl,
        totalFields: fields.length,
        composedFields: composedCount,
        coveragePercent: coveragePct,
        xfaLabelCount,
        needsReviewCount,
        generatedAt: new Date().toISOString()
      }
    };
  }

  // ─── Download PDF with timeout ───
  async function downloadPDF(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return new Uint8Array(await resp.arrayBuffer());
    } catch (e) {
      clearTimeout(timeout);
      throw e;
    }
  }

  // ─── Process single form ───
  async function processForm(form) {
    const { name, path } = form;
    if (stopped) throw new Error('Stopped');

    window._vbaProgress.current = name;
    const url = 'https://www.vba.va.gov' + path;

    try {
      const uint8 = await downloadPDF(url);
      const { fields, xfaLabelCount, pageCount } = await extractFields(uint8);

      if (fields.length === 0) {
        // Flat PDF — store minimal schema
        window._vbaSchemas[name] = {
          $schema: 'http://json-schema.org/draft-07/schema#',
          title: name,
          type: 'object',
          properties: {},
          'x-va-metadata': { formUrl: url, totalFields: 0, composedFields: 0, coveragePercent: 0, xfaLabelCount: 0, needsReviewCount: 0, status: 'flat', pageCount, generatedAt: new Date().toISOString() }
        };
        console.log(`○ ${name}: flat PDF (${pageCount} pages, 0 fields)`);
      } else {
        const schema = generateSchema(name, url, fields, xfaLabelCount);
        schema['x-va-metadata'].pageCount = pageCount;
        schema['x-va-metadata'].status = 'digitized';
        window._vbaSchemas[name] = schema;
        const meta = schema['x-va-metadata'];
        console.log(`✓ ${name}: ${meta.totalFields} fields, ${meta.coveragePercent}% coverage, ${meta.xfaLabelCount} XFA labels, ${meta.needsReviewCount} need review`);
      }
      window._vbaProgress.processed++;
    } catch (e) {
      const msg = name + ': ' + e.message;
      window._vbaProgress.errors.push(msg);
      window._vbaProgress.processed++;
      console.error('✗ ' + msg);
    }
  }

  // ─── Batch with concurrency ───
  async function runBatch(forms) {
    const queue = [...forms];
    const workers = [];

    const processNext = async () => {
      while (queue.length > 0 && !stopped) {
        const form = queue.shift();
        await processForm(form);
      }
    };

    for (let i = 0; i < MAX_CONCURRENT; i++) {
      workers.push(processNext());
    }
    await Promise.all(workers);
  }

  // ─── Entry points ───
  window.startVBABatch = async function(forms) {
    await ensurePdfLib();
    stopped = false;
    window._vbaSchemas = {};
    window._vbaProgress = { processed: 0, total: forms.length, current: null, errors: [] };

    console.log('═══════════════════════════════════════');
    console.log(`Starting batch: ${forms.length} VBA forms`);
    console.log('═══════════════════════════════════════');
    const t0 = Date.now();

    await runBatch(forms);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const p = window._vbaProgress;
    console.log('═══════════════════════════════════════');
    console.log(`Done in ${elapsed}s. Processed: ${p.processed}/${p.total}, Errors: ${p.errors.length}`);
    console.log(`Schemas stored in window._vbaSchemas (${Object.keys(window._vbaSchemas).length} forms)`);
    console.log('═══════════════════════════════════════');
  };

  window.stopVBABatch = function() {
    stopped = true;
    console.log('Batch stopped.');
  };

  console.log('VBA batch processor loaded. Call startVBABatch(forms) to begin.');
})();
