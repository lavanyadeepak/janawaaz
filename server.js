require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');
const crypto = require('crypto');
const fs = require('fs');
const puppeteer = require('puppeteer');

const app    = express();
const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } }); // 5 MB
const TRANSLATION_API_URL = process.env.TRANSLATION_API_URL || 'http://127.0.0.1:8000';
const TRANSLATION_TIMEOUT_MS = Number(process.env.TRANSLATION_TIMEOUT_MS || 60000);
const LANGUAGES_TIMEOUT_MS = Number(process.env.LANGUAGES_TIMEOUT_MS || 7000);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, ''))); // serves index.html

// Log unexpected crashes so PDF-generation issues don't fail silently.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err && err.stack ? err.stack : err);
});

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function encryptIP(ip, key) {
  // Normalize IP
  const cleanIP = ip === '::1' ? '127.0.0.1' : ip.replace(/^::ffff:/, '');
  
  // Pad key to 32 bytes for AES-256
  const keyBuffer = Buffer.alloc(32);
  Buffer.from(key).copy(keyBuffer);
  
  // Fixed IV derived from key (deterministic — same IP+date = same token)
  const iv = crypto.createHash('md5').update(key).digest(); // 16 bytes
  
  const cipher = crypto.createCipheriv('aes-256-cbc', keyBuffer, iv);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(cleanIP)),
    cipher.final()
  ]);
  
  return encrypted.toString('hex').toUpperCase();
}

function decryptIP(token, key) {
  const keyBuffer = Buffer.alloc(32);
  Buffer.from(key).copy(keyBuffer);
  
  const iv = crypto.createHash('md5').update(key).digest();
  
  const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuffer, iv);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(token, 'hex')),
    decipher.final()
  ]);
  
  return decrypted.toString();
}

// ── In your route ─────────────────────────────────────────────────────────────
function buildDocketNo(req) {
  const raw = req.headers['x-forwarded-for']?.split(',')[0].trim()
            || req.ip
            || '127.0.0.1';
  const ip = raw === '::1' ? '127.0.0.1' : raw.replace(/^::ffff:/, '');

  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // e.g. 20260516
  const token    = encryptIP(ip, datePart); // e.g. A3F9C12D...

  return { docketNo: `JA-${datePart}-${token}`, ip, datePart };
}

// ── To investigate any docket later ──────────────────────────────────────────
function resolveIPFromDocket(docketNo) {
  // e.g. "JA-20260516-A3F9C12D..."
  const parts    = docketNo.split('-');
  const datePart = parts[1];  // 20260516
  const token    = parts[2];  // encrypted hex
  return decryptIP(token, datePart);
}

async function parseTranslationResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  const isJson = contentType.toLowerCase().includes('application/json');

  const payload = isJson ? await response.json() : await response.text();
  if (typeof payload === 'string') return payload;

  if (!payload || typeof payload !== 'object') return '';

  const pickString = (value, depth = 0) => {
    if (typeof value === 'string') return value;
    if (depth > 4) return '';
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = pickString(item, depth + 1);
        if (found) return found;
      }
      return '';
    }
    if (value && typeof value === 'object') {
      const directKeys = [
        'translated_text', 'translation', 'translatedText',
        'translated_sentence', 'translatedSentence', 'text',
        'output', 'result', 'generated_text', 'generatedText',
      ];
      for (const k of directKeys) {
        const found = pickString(value[k], depth + 1);
        if (found) return found;
      }
      return '';
    }
    return '';
  };

  const candidates = [
    payload.translated_text, payload.translation, payload.translatedText,
    payload.translated_sentences, payload.translatedSentences,
    payload.output, payload.text, payload.result,
    payload.generated_text, payload.generatedText,
    payload.data?.translated_text, payload.data?.translation,
    payload.data?.text, payload.data?.translated_sentences,
    payload.data?.translatedSentences, payload.data?.generated_text,
    payload.data?.generatedText,
  ];

  for (const candidate of candidates) {
    const found = pickString(candidate);
    if (found) return found;
  }

  const nestedArrays = [
    payload.translations, payload.outputs, payload.translated,
    payload.data?.translations, payload.data?.outputs, payload.data?.translated,
  ];
  for (const arr of nestedArrays) {
    if (Array.isArray(arr) && arr.length > 0) {
      const found = pickString(arr[0]);
      if (found) return found;
    }
  }

  let best = '';
  const seen = new Set();
  const crawl = (node, depth = 0) => {
    if (!node || depth > 4) return;
    if (typeof node === 'string') {
      const s = node.trim();
      if (s.length >= 20 && s.length > best.length) best = s;
      return;
    }
    if (Array.isArray(node)) { for (const item of node) crawl(item, depth + 1); return; }
    if (typeof node === 'object') {
      if (seen.has(node)) return;
      seen.add(node);
      for (const [k, v] of Object.entries(node)) {
        if (['src_lang','tgt_lang','lang','language'].includes(k)) continue;
        crawl(v, depth + 1);
      }
    }
  };
  crawl(payload, 0);
  return best || '';
}

// ── Font helpers ─────────────────────────────────────────────────────────────

const FONT_BY_LANGUAGE = {
  Hindi: 'NotoSansDevanagari-Regular.ttf',
  Marathi: 'NotoSansDevanagari-Regular.ttf',
  Nepali: 'NotoSansDevanagari-Regular.ttf',
  Sanskrit: 'NotoSansDevanagari-Regular.ttf',
  Konkani: 'NotoSansDevanagari-Regular.ttf',
  Maithili: 'NotoSansDevanagari-Regular.ttf',
  Bodo: 'NotoSansDevanagari-Regular.ttf',
  Dogri: 'NotoSansDevanagari-Regular.ttf',

  Tamil: 'NotoSansTamil-Regular.ttf',
  Telugu: 'NotoSansTelugu-Regular.ttf',
  Kannada: 'NotoSansKannada-Regular.ttf',
  Malayalam: 'NotoSansMalayalam-Regular.ttf',
  Bengali: 'NotoSansBengali-Regular.ttf',
  Assamese: 'NotoSansBengali-Regular.ttf',
  Gujarati: 'NotoSansGujarati-Regular.ttf',
  Punjabi: 'NotoSansGurmukhi-Regular.ttf',
  Odia: 'NotoSansOriya-Regular.ttf',
  Urdu: 'NotoNaskhArabic-Regular.ttf',
  Sindhi: 'NotoNaskhArabic-Regular.ttf',
  Kashmiri: 'NotoNaskhArabic-Regular.ttf',
  Manipuri: 'NotoSansBengali-Regular.ttf',
  Santali: 'NotoSansDevanagari-Regular.ttf',
  Sinhala: 'NotoSansSinhala-Regular.ttf',
};

/**
 * Pre-register all fonts that exist on disk and return a map of
 * language -> registered font name. Called once per PDF document.
 */
function buildFontRegistry(doc) {
  const fontsDir = path.join(__dirname, 'fonts');
  const registry = {}; // language -> PDFKit font name

  const registered = new Map(); // absPath -> name
  let counter = 0;

  const tryRegister = (absPath) => {
    if (registered.has(absPath)) return registered.get(absPath);
    if (!fs.existsSync(absPath)) return null;
    const name = `F_${++counter}`;
    try {
      doc.registerFont(name, absPath);
      registered.set(absPath, name);
      return name;
    } catch (e) {
      console.warn(`[Font] Failed to register ${absPath}: ${e.message}`);
      return null;
    }
  };

  for (const [language, fileName] of Object.entries(FONT_BY_LANGUAGE)) {
    const absPath = path.join(fontsDir, fileName);
    const name = tryRegister(absPath);
    if (name) {
      registry[language] = name;
    } else {
      // Try generic fallback fonts
      const fallbacks = [
        'NotoSans-Regular.ttf',
        'NotoSansDevanagari-Regular.ttf',
      ];
      for (const fb of fallbacks) {
        const fbPath = path.join(fontsDir, fb);
        const fbName = tryRegister(fbPath);
        if (fbName) { registry[language] = fbName; break; }
      }
      // If still nothing, mark as Helvetica (will render Latin only)
      if (!registry[language]) registry[language] = 'Helvetica';
    }
  }

  return registry;
}

// ── Clean complaint text ──────────────────────────────────────────────────────
// Strips stray non-printable / mis-encoded characters that appear when the
// frontend sends UTF-8 text that got double-encoded or pasted from Word.
function sanitizeText(text) {
  if (!text) return '';
  return text
    // Remove the common Windows-1252 mojibake character Ð (U+00D0) used as line break
    .replace(/\u00D0/g, '\n')
    // Collapse more than two consecutive newlines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── PDF Booklet (Chromium/Puppeteer) ─────────────────────────────────────────
// Uses Chromium shaping/rendering (more reliable for Devanagari/Indic scripts).
async function generatePDFBooklet(res, { englishLetter, results, docketNo, attachment }) {
  const fontsDir = path.join(__dirname, 'fonts');

  const escapeHtml = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;')
      .replace(/'/g, '&#039;');

  const toDataUrl = (absPath) => {
    const buf = fs.readFileSync(absPath);
    const b64 = buf.toString('base64');
    const ext = path.extname(absPath).toLowerCase();
    const mime =
      ext === '.otf' ? 'font/otf' :
      ext === '.ttc' ? 'font/collection' :
      'font/ttf';
    return `data:${mime};base64,${b64}`;
  };

  const langToFontFile = (language) => {
    if (FONT_BY_LANGUAGE[language]) return FONT_BY_LANGUAGE[language];
    return 'NotoSansDevanagari-Regular.ttf';
  };

  const wantedLanguages = [...new Set((results || []).map(r => r.language).filter(Boolean))];
  const uniqueFontFiles = new Set();
  for (const lang of wantedLanguages) uniqueFontFiles.add(langToFontFile(lang));

  const embeddedFonts = [];
  for (const fileName of uniqueFontFiles) {
    const absPath = path.join(fontsDir, fileName);
    if (!fs.existsSync(absPath)) continue;
    embeddedFonts.push({ fileName, dataUrl: toDataUrl(absPath) });
  }

  if (embeddedFonts.length > 0) {
    console.log('[PDF fonts] Embedded (HTML): ' + embeddedFonts.map(f => f.fileName).join(', '));
  } else {
    console.warn(`[PDF fonts] No font files found in ${fontsDir}. PDFs may not render Indic scripts correctly.`);
  }

  const fontFaceCss = embeddedFonts
    .map((f) => {
      const family = `F_${f.fileName.replace(/[^a-zA-Z0-9]+/g, '_')}`;
      // Use truetype for .ttf/.ttc for Chromium; it will still load most .ttc as TrueType Collections.
      return `@font-face{font-family:'${family}';src:url('${f.dataUrl}') format('truetype');font-weight:400;font-style:normal;}`;
    })
    .join('\n');

  const langFontFamily = (language) => {
    const fileName = langToFontFile(language);
    const family = `F_${fileName.replace(/[^a-zA-Z0-9]+/g, '_')}`;
    return embeddedFonts.some(f => f.fileName === fileName)
      ? `'${family}', sans-serif`
      : `sans-serif`;
  };

  let attachmentHtml = '';
  if (attachment) {
    if (attachment.mimetype && attachment.mimetype.startsWith('image/')) {
      const imageB64 = attachment.buffer.toString('base64');
      const imageSrc = `data:${attachment.mimetype};base64,${imageB64}`;
      attachmentHtml = `
        <div class="page">
          <div class="header annex">Annexures and Exhibits</div>
          <div class="content">
            <div class="muted">Attached image: ${escapeHtml(attachment.originalname || '')}</div>
            <div class="annex-image-wrap">
              <img class="annex-image" src="${imageSrc}" />
            </div>
          </div>
        </div>
      `;
    } else {
      attachmentHtml = `
        <div class="page">
          <div class="header annex">Annexures and Exhibits</div>
          <div class="content">
            <div class="muted">Attached file: ${escapeHtml(attachment.originalname || '')} (${escapeHtml(attachment.mimetype || 'unknown')})</div>
            <div class="muted">Note: PDF merging is not enabled in this local build.</div>
          </div>
        </div>
      `;
    }
  }

  const translationsHtml = (results || [])
    .filter(r => r.language && r.language !== 'English')
    .map((r) => {
      const lang = r.language;
      const family = langFontFamily(lang);
      const body = r.error
        ? `<div class="error">Translation unavailable: ${escapeHtml(r.error)}</div>
           <div class="muted">Refer to the English original.</div>`
        : `<div class="letter" style="font-family:${family}">${escapeHtml(r.letter || '').replace(/\n/g, '<br/>')}</div>`;
      return `
        <div class="page">
          <div class="header green">${escapeHtml(lang)} Translation</div>
          <div class="notice">MACHINE GENERATED TRANSLATION — FOR REFERENCE ONLY</div>
          <div class="content">
            ${body}
          </div>
          <div class="footer">Note: Refer to the English version for legal accuracy.</div>
        </div>
      `;
    })
    .join('\n');

  const tocItems = [
    { label: 'Original Petition (English)' },
    ...((results || []).filter(r => r.language && r.language !== 'English').map(r => ({ label: `${r.language} Translation` }))),
    ...(attachment ? [{ label: 'Annexures & Exhibits' }] : []),
    { label: 'Closing Statement' },
  ];

  const html = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    ${fontFaceCss}
    @page { size: A4; margin: 18mm 16mm; }
    body { font-family: sans-serif; color: #222; }
    .page { page-break-after: always; }
    .header { background: #1a3a5c; color: #fff; padding: 12px 14px; font-size: 18px; font-weight: 700; border-radius: 10px; }
    .header.green { background: #2d6a4f; }
    .header.annex { background: #5c3a1a; }
    .badge { display:inline-block; margin-top:10px; padding:6px 10px; border-radius:999px; background:#eef3ff; color:#1a3a5c; font-weight:700; font-size:12px; }
    .content { margin-top: 14px; font-size: 12px; line-height: 1.5; }
    .muted { color: #666; }
    .notice { margin: 10px 0 0; font-size: 10px; color: #555; text-align: center; letter-spacing: .08em; }
    .footer { margin-top: 14px; font-size: 10px; color: #777; text-align: center; }
    .toc { margin-top: 14px; border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden; }
    .toc-row { display:flex; justify-content:space-between; padding: 10px 12px; font-size: 12px; }
    .toc-row:nth-child(odd){ background:#f5f7fb; }
    .letter { white-space: normal; }
    .error { color: #b00020; font-weight: 600; margin-bottom: 8px; }
    .annex-image-wrap { margin-top: 12px; display:flex; justify-content:center; }
    .annex-image { max-width: 100%; max-height: 680px; object-fit: contain; border: 1px solid #eee; border-radius: 10px; }
  </style>
  <title>Petition ${escapeHtml(docketNo)}</title>
</head>
<body>
  <div class="page">
    <div class="header">JAN AWAAZ — जन आवाज़</div>
    <div class="badge">Docket No: ${escapeHtml(docketNo)}</div>
    <div class="content">
      <p>This document contains the original petition and supporting materials submitted for grievance redressal.</p>
      <p class="muted">Machine-generated translations are included for administrative convenience only.</p>
      <p class="muted"><strong>Disclaimer:</strong> Translations are machine-generated. Accuracy is not guaranteed. Only the citizen’s original draft is legally binding.</p>
    </div>
  </div>

  <div class="page">
    <div class="header">Table of Contents</div>
    <div class="content">
      <div class="toc">
        ${tocItems.map((it, idx) => `<div class="toc-row"><div>${idx + 1}. ${escapeHtml(it.label)}</div></div>`).join('')}
      </div>
      <div class="muted" style="margin-top:10px;">(Page numbers are omitted in this local build.)</div>
    </div>
  </div>

  <div class="page">
    <div class="header">Original Petition (English)</div>
    <div class="content">
      <div class="letter" style="font-family: Helvetica, Arial, sans-serif">${escapeHtml(englishLetter || '').replace(/\n/g, '<br/>')}</div>
    </div>
  </div>

  ${translationsHtml}
  ${attachmentHtml}

  <div class="page">
    <div class="header">Closing Statement</div>
<div class="content">
  <div class="seal-ring">
    <span class="seal-en">JAN AWAAZ</span>
    <span class="seal-hi">जन आवाज़</span>
  </div>

  <p class="closing-title">Petition Formally Recorded</p>
  <p class="closing-docket">Docket No: ${escapeHtml(docketNo)}</p>

  <p class="closing-note">
    This petition was prepared and submitted through the
    <strong>JanAwaaz Citizen Grievance Portal</strong> —
    a free, open platform empowering every Indian citizen
    to file grievances in their own language.
  </p>

  <p class="closing-note" style="margin-top:10px">
    Built with the belief that <em>language should never be a barrier to justice.</em>
  </p>

  <div class="closing-divider"></div>

  <p class="closing-meta">🌐 Jan Awaaz &nbsp;|&nbsp; जन आवाज़ &nbsp;|&nbsp; Your Voice. Your Rights. In Your Language.</p>
  <p class="muted">Docket No: ${escapeHtml(docketNo)} &nbsp;·&nbsp; System-generated · No signature required.</p>
</div>
  </div>
</body>
</html>
.closing-title {
  font-size: 20px;
  font-weight: bold;
  color: #1a3a5c;
  margin-bottom: 10px;
}
.closing-docket {
  font-size: 12px;
  color: #444;
  margin-bottom: 24px;
}
.closing-note {
  font-size: 11px;
  color: #555;
  max-width: 400px;
  line-height: 1.8;
  text-align: center;
}
.closing-divider {
  width: 60px;
  height: 2px;
  background: #1a3a5c;
  margin: 24px auto;
  border-radius: 2px;
}
.closing-meta {
  font-size: 11px;
  font-weight: 600;
  color: #1a3a5c;
  letter-spacing: 0.3px;
  margin-bottom: 8px;
}
.muted {
  font-size: 9px;
  color: #aaa;
}
  `.trim();

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const pdfBytes = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', right: '16mm', bottom: '18mm', left: '16mm' },
    });
    const pdfBuffer = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=Petition_${docketNo}.pdf`);
    res.send(pdfBuffer);
  } finally {
    await browser.close();
  }
}

async function safeGeneratePdf(res, pdfArgs) {
  try {
    await generatePDFBooklet(res, pdfArgs);
  } catch (e) {
    console.error('PDF generation error:', e && e.stack ? e.stack : e);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to generate PDF. ' + (e?.message || e) });
    } else {
      try { res.end(); } catch (_e) {}
    }
  }
}

function ipToNumber(ip) {
  const parts = ip.split('.').map(Number);
  return (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
}

function numberToIp(num) {
  return [
    (num >> 24) & 255,
    (num >> 16) & 255,
    (num >> 8) & 255,
    num & 255
  ].join('.');
}

// ── Translation helpers ───────────────────────────────────────────────────────
async function translateParagraph({ text, src_lang, tgt_lang }) {
  if (!text) return '';
  console.log(`[Translation] ${src_lang} -> ${tgt_lang} (${text.length} characters)`);

  const url = `${TRANSLATION_API_URL}/translate`;
  let translationResponse;
  try {
    translationResponse = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sentences: [text], src_lang, tgt_lang }),
    }, TRANSLATION_TIMEOUT_MS);
  } catch (e) {
    if (e && (e.name === 'AbortError' || String(e.message || '').toLowerCase().includes('aborted'))) {
      throw new Error(`Translation request timed out after ${TRANSLATION_TIMEOUT_MS}ms (${url})`);
    }
    throw new Error(`Translation request failed (${url}): ${e?.message || e}`);
  }

  if (!translationResponse.ok) {
    let details = '';
    try { details = await translationResponse.text(); } catch (_e) {}
    throw new Error(`Translation failed (${translationResponse.status})${details ? `: ${details}` : ''}`);
  }

  return await parseTranslationResponse(translationResponse);
}

// Map common names to ISO 639-3 prefixes used by IndicTrans2
const NAME_TO_ISO = {
  'Hindi': 'hin', 'Tamil': 'tam', 'Telugu': 'tel', 'Kannada': 'kan',
  'Malayalam': 'mal', 'Bengali': 'ben', 'Marathi': 'mar', 'Gujarati': 'guj',
  'Punjabi': 'pan', 'English': 'eng', 'Odia': 'ory', 'Assamese': 'asm',
  'Urdu': 'urd', 'Sanskrit': 'san', 'Nepali': 'npi', 'Sindhi': 'snd',
  'Maithili': 'mai', 'Dogri': 'doi', 'Konkani': 'gom', 'Manipuri': 'mni',
  'Bodo': 'brx', 'Santali': 'sat', 'Kashmiri': 'kas', 'Sinhala': 'sin'
};

// ── POST /api/generate-petition ──────────────────────────────────────────────
app.post(
  '/api/generate-petition',
  upload.single('attachment'),
  async (req, res) => {
    const { state, department, petitioner, complaint } = req.body;

    let languages = req.body['languages[]'] || req.body.languages || [];
    if (typeof languages === 'string') languages = languages.split(',');
    if (!Array.isArray(languages)) languages = [languages];

    if (!languages.includes('Hindi')) languages.push('Hindi');
    languages = [...new Set(languages)];

    if (!state || !department || !complaint) {
      return res.status(400).json({ error: 'state, department and complaint are required' });
    }

    try {
      const today = new Date().toLocaleDateString('en-IN', {
        day: 'numeric', month: 'long', year: 'numeric',
      });

const { docketNo } = (req.body.docketNo && String(req.body.docketNo).trim())
  ? { docketNo: String(req.body.docketNo).trim() }
  : buildDocketNo(req);
  
      // Sanitize complaint text to strip mojibake / stray encoding artifacts
      const cleanComplaint = sanitizeText(complaint);

      const englishLetter = generateBaseEnglishLetter({
        state, department, petitioner,
        complaint: cleanComplaint,
        today,
      });

      // If the frontend already generated preview letters, it can send them as `lettersJson`
      // so we can collate/bind them into a PDF without re-calling the translation service.
      let providedLetters = null;
      if (typeof req.body.lettersJson === 'string' && req.body.lettersJson.trim()) {
        try {
          const parsed = JSON.parse(req.body.lettersJson);
          if (Array.isArray(parsed)) {
            providedLetters = parsed
              .filter(x => x && typeof x === 'object')
              .map(x => ({
                language: String(x.language || '').trim(),
                letter: typeof x.letter === 'string' ? x.letter : '',
                error: x.error ? String(x.error) : undefined,
              }))
              .filter(x => x.language);
          }
        } catch (_e) {
          providedLetters = null;
        }
      }

      if (providedLetters && providedLetters.length > 0) {
        const byLang = new Map();
        for (const item of providedLetters) {
          if (!byLang.has(item.language)) byLang.set(item.language, item);
        }

        const results = [];
        for (const language of languages) {
          const hit = byLang.get(language);
          if (hit && typeof hit.letter === 'string' && hit.letter.trim()) {
            results.push({ language, letter: hit.letter, error: hit.error });
          } else if (language === 'English') {
            results.push({ language, letter: englishLetter });
          } else {
            results.push({ language, letter: englishLetter, error: hit?.error || 'Missing cached letter; using English fallback' });
          }
        }

        if (req.query.format === 'pdf') {
          const englishFromProvided = byLang.get('English')?.letter;
          await safeGeneratePdf(res, {
            englishLetter: (typeof englishFromProvided === 'string' && englishFromProvided.trim()) ? englishFromProvided : englishLetter,
            results,
            docketNo,
            attachment: req.file
          });
          return;
        }

        return res.json({ letters: results, docketNo, source: 'cached' });
      }

      let supportedLanguages = [];
      try {
        const langRes = await fetchWithTimeout(`${TRANSLATION_API_URL}/languages`, {}, LANGUAGES_TIMEOUT_MS);
        const langData = await langRes.json();
        supportedLanguages = langData.supported_languages || [];
      } catch (e) {
        console.warn('Translation service languages endpoint unreachable, using fallback logic');
      }

      const results = [];
      for (const language of languages) {
        try {
          if (language === 'English') {
            results.push({ language, letter: englishLetter });
            continue;
          }

          const prefix = NAME_TO_ISO[language] || 'hin';
          const tgt_lang = supportedLanguages.find(c => c.startsWith(prefix)) || 'hin_Deva';

          const translated = await translateParagraph({
            text: englishLetter,
            src_lang: 'eng_Latn',
            tgt_lang,
          });

          results.push({ language, letter: translated || englishLetter });
        } catch (err) {
          results.push({ language, letter: englishLetter, error: err.message || 'Translation failed' });
        }
      }

      if (req.query.format === 'pdf') {
        await safeGeneratePdf(res, { englishLetter, results, docketNo, attachment: req.file });
        return;
      }

      res.json({ letters: results, docketNo });
    } catch (err) {
      console.error('Processing error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to generate or translate petition. ' + err.message });
      } else {
        try { res.end(); } catch (_e) {}
      }
    }
  }
);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// ── Letter template ───────────────────────────────────────────────────────────
function generateBaseEnglishLetter({ state, department, petitioner, complaint, today }) {
  return `To,
The Head of Department,
${department},
${state}.

Date: ${today}

SUBJECT: FORMAL PETITION REGARDING ${complaint.substring(0, 60).toUpperCase()}...

Respected Sir/Madam,

I, ${petitioner || 'the undersigned'}, am writing this formal petition to bring to your urgent attention a grievance regarding the following matter:

${complaint}

This issue has caused significant inconvenience and hardship. I earnestly request your office to look into this matter and take the necessary corrective actions at the earliest.

I look forward to your positive response and an official acknowledgement of this petition.

Yours faithfully,

(Signature)

${petitioner || 'The Petitioner'}`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Jan Awaaz server running on http://localhost:${PORT}`));
