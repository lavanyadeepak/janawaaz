require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');
const PDFDocument = require('pdfkit');
const fs = require('fs');

const app    = express();
const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } }); // 5 MB
const TRANSLATION_API_URL = process.env.TRANSLATION_API_URL || 'http://127.0.0.1:8000';
const TRANSLATION_TIMEOUT_MS = Number(process.env.TRANSLATION_TIMEOUT_MS || 60000);
const LANGUAGES_TIMEOUT_MS = Number(process.env.LANGUAGES_TIMEOUT_MS || 7000);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, ''))); // serves index.html

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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

// ── PDF Booklet ───────────────────────────────────────────────────────────────
async function generatePDFBooklet(res, { englishLetter, results, docketNo, attachment }) {
  const doc = new PDFDocument({ margin: 50, size: 'A4', autoFirstPage: false });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=Petition_${docketNo}.pdf`);
  doc.pipe(res);

  // Pre-register all Indic fonts before writing any page content
  const fontRegistry = buildFontRegistry(doc);

  const useFontForLanguage = (language) => {
    if (language === 'English') { doc.font('Helvetica'); return; }
    const fontName = fontRegistry[language];
    if (fontName) { doc.font(fontName); return; }
    doc.font('Helvetica'); // last resort
  };

  // ── PAGE 1: COVER / INTRODUCTION ──────────────────────────────────────────
  doc.addPage();

  // Header banner
  doc.rect(0, 0, doc.page.width, 80).fill('#1a3a5c');
  doc.fillColor('#ffffff')
    .fontSize(26).font('Helvetica-Bold')
    .text('JAN AWAAZ', 50, 22, { align: 'center' });
  doc.fontSize(13).font('Helvetica')
    .text('जन आवाज़  |  The People\'s Voice', 50, 52, { align: 'center' });

  doc.fillColor('#1a3a5c').fontSize(11).font('Helvetica-Bold')
    .text(`Docket No: ${docketNo}`, 50, 100);

  doc.moveDown(2);
  doc.font('Helvetica').fontSize(11).fillColor('#222222').lineGap(4)
    .text('This document contains the original petition and supporting materials submitted for grievance redressal.', { align: 'justify' });
  doc.moveDown();
  doc.text('The original petition is the authentic version drafted by the complainant.', { align: 'justify' });
  doc.moveDown();
  doc.text('Machine-generated translations are provided for administrative convenience in regional and Hindi languages.', { align: 'justify' });
  doc.moveDown();
  doc.text('Annexures include any supporting documents attached by the complainant.', { align: 'justify' });

  // Disclaimer box — no hyperlink, no underline, plain styled box
  doc.moveDown(2);
  const disclaimerTop = doc.y;
  doc.rect(50, disclaimerTop, doc.page.width - 100, 80).fill('#fff3cd').stroke('#e6ac00');
  doc.fillColor('#7d4e00').fontSize(11).font('Helvetica-Bold')
    .text('Disclaimer', 62, disclaimerTop + 10, { underline: false });
  doc.font('Helvetica').fillColor('#5a3800').fontSize(10)
    .text(
      'Translations are machine-generated. Accuracy is not guaranteed. They must always be read in tandem with the original petition. Only the citizen\'s original draft is legally binding.',
      62, disclaimerTop + 28,
      { width: doc.page.width - 124, align: 'justify' }
    );

  // ── PAGE 2: TABLE OF CONTENTS ─────────────────────────────────────────────
  doc.addPage();

  doc.rect(0, 0, doc.page.width, 60).fill('#1a3a5c');
  doc.fillColor('#ffffff').fontSize(18).font('Helvetica-Bold')
    .text('Table of Contents', 50, 18, { align: 'center' });

  doc.fillColor('#222222').fontSize(12).font('Helvetica');
  doc.moveDown(2.5);

  const tocItems = [
    { label: 'Original Petition (English)', page: 3 },
  ];
  let pageCounter = 4;
  for (const r of results) {
    if (r.language !== 'English') {
      tocItems.push({ label: `${r.language} Translation`, page: pageCounter++ });
    }
  }
  if (attachment) {
    tocItems.push({ label: 'Annexures & Exhibits', page: pageCounter });
  }
  tocItems.push({ label: 'Closing Statement', page: pageCounter + (attachment ? 1 : 0) });

  tocItems.forEach((item, idx) => {
    const num = idx + 1;
    const y = doc.y;
    // Alternating row tint
    if (idx % 2 === 0) {
      doc.rect(50, y - 4, doc.page.width - 100, 22).fill('#f0f4f8').stroke();
    }
    doc.fillColor('#1a3a5c').font('Helvetica-Bold').fontSize(11)
      .text(`${num}.`, 60, y, { continued: true, width: 20 });
    doc.font('Helvetica').fillColor('#222222')
      .text(`  ${item.label}`, { continued: true });
    doc.fillColor('#666666')
      .text(`Page ${item.page}`, { align: 'right', width: doc.page.width - 160 });
    doc.moveDown(0.5);
  });

  // ── PAGE 3: ENGLISH ORIGINAL ──────────────────────────────────────────────
  doc.addPage();
  doc.addNamedDestination('P3');

  doc.rect(0, 0, doc.page.width, 60).fill('#1a3a5c');
  doc.fillColor('#ffffff').fontSize(16).font('Helvetica-Bold')
    .text('Original Petition (English)', 50, 18, { align: 'center' });

  doc.fillColor('#222222').moveDown(2);
  doc.font('Helvetica').fontSize(10).lineGap(3)
    .text(englishLetter, { align: 'justify' });

  // ── TRANSLATION PAGES ─────────────────────────────────────────────────────
  let translationPageNum = 4;
  for (const result of results) {
    if (result.language === 'English') continue;

    doc.addPage();
    const destKey = `P${translationPageNum++}`;
    doc.addNamedDestination(destKey);

    // Header
    doc.rect(0, 0, doc.page.width, 60).fill('#2d6a4f');
    doc.fillColor('#ffffff').fontSize(16).font('Helvetica-Bold')
      .text(`${result.language} Translation`, 50, 18, { align: 'center' });

    // Machine translation notice
    doc.fillColor('#555555').fontSize(8).font('Helvetica')
      .text('[ MACHINE GENERATED TRANSLATION — FOR REFERENCE ONLY ]', 50, 68, { align: 'center' });

    if (result.error) {
      doc.moveDown(2).fillColor('#cc0000').fontSize(10)
        .text(`Translation unavailable: ${result.error}`);
      doc.fillColor('#222222').moveDown()
        .text('Please refer to the English original on Page 3.');
    } else {
      doc.fillColor('#222222').moveDown(2).fontSize(10).lineGap(3);
      useFontForLanguage(result.language);
      doc.text(result.letter || '', { align: 'justify' });
    }

    // Footer note
    doc.font('Helvetica').fillColor('#888888').fontSize(8)
      .text(
        'Note: This is an automated translation. Refer to Page 3 for the legally binding English version.',
        50, doc.page.height - 60,
        { align: 'center', width: doc.page.width - 100 }
      );
  }

  // ── ANNEXURES ─────────────────────────────────────────────────────────────
  if (attachment) {
    doc.addPage();
    doc.addNamedDestination('PANNEX');

    doc.rect(0, 0, doc.page.width, 60).fill('#5c3a1a');
    doc.fillColor('#ffffff').fontSize(16).font('Helvetica-Bold')
      .text('Annexures and Exhibits', 50, 18, { align: 'center' });

    doc.fillColor('#222222').moveDown(2);
    if (attachment.mimetype.startsWith('image/')) {
      try {
        doc.image(attachment.buffer, { fit: [500, 580], align: 'center', valign: 'center' });
      } catch (err) {
        doc.font('Helvetica').text('Error rendering attachment image.');
      }
    } else {
      doc.font('Helvetica').fontSize(10)
        .text(`Attached file: ${attachment.originalname} (${attachment.mimetype})`);
      doc.moveDown()
        .text('Note: PDF/Document merging requires additional server-side processing.');
    }
  }

  // ── CLOSING PAGE ──────────────────────────────────────────────────────────
  doc.addPage();

  // Full-page background
  doc.rect(0, 0, doc.page.width, doc.page.height).fill('#f7f9fc');

  // Top accent bar
  doc.rect(0, 0, doc.page.width, 8).fill('#1a3a5c');

  // Central seal / emblem placeholder (circle)
  const cx = doc.page.width / 2;
  doc.circle(cx, 200, 60).lineWidth(3).strokeColor('#1a3a5c').fillColor('#ffffff').fillAndStroke();
  doc.fillColor('#1a3a5c').fontSize(11).font('Helvetica-Bold')
    .text('JAN AWAAZ', cx - 40, 185);
  doc.fontSize(9).font('Helvetica')
    .text('जन आवाज़', cx - 22, 200);

  doc.fillColor('#1a3a5c').fontSize(20).font('Helvetica-Bold')
    .text('Petition Successfully Submitted', 50, 290, { align: 'center' });

  doc.moveDown(0.5).fillColor('#444444').fontSize(11).font('Helvetica')
    .text(`Docket No: ${docketNo}`, { align: 'center' });

  doc.moveDown(2).fontSize(10).fillColor('#555555')
    .text(
      'Your grievance has been formally recorded and will be reviewed by the concerned department. ' +
      'You may quote the above Docket Number for all future correspondence and follow-ups.',
      70, doc.y,
      { align: 'center', width: doc.page.width - 140 }
    );

  doc.moveDown(2).fontSize(10).fillColor('#777777')
    .text('This is a system-generated document. No signature is required.', { align: 'center' });

  // Bottom accent bar
  doc.rect(0, doc.page.height - 8, doc.page.width, 8).fill('#1a3a5c');

  doc.end();
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

      const randomId = Math.floor(1000 + Math.random() * 9000);
      const docketNo = `JA-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${randomId}`;

      // Sanitize complaint text to strip mojibake / stray encoding artifacts
      const cleanComplaint = sanitizeText(complaint);

      const englishLetter = generateBaseEnglishLetter({
        state, department, petitioner,
        complaint: cleanComplaint,
        today,
      });

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
        return await generatePDFBooklet(res, {
          englishLetter, results, docketNo, attachment: req.file
        });
      }

      res.json({ letters: results, docketNo });
    } catch (err) {
      console.error('Processing error:', err.message);
      res.status(500).json({ error: 'Failed to generate or translate petition. ' + err.message });
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