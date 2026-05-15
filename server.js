require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');
const PDFDocument = require('pdfkit');

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

  const candidates = [
    payload.translated_text,
    payload.translation,
    payload.translatedText,
    payload.output,
    payload.text,
    payload.result,
    payload.data?.translated_text,
    payload.data?.translation,
    payload.data?.text,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string') return candidate;
    if (Array.isArray(candidate) && typeof candidate[0] === 'string') return candidate[0];
  }

  // Some servers return { translations: [{ text: "..." }] } or similar.
  const nestedArrays = [
    payload.translations,
    payload.outputs,
    payload.data?.translations,
    payload.data?.outputs,
  ];
  for (const arr of nestedArrays) {
    if (Array.isArray(arr) && arr.length > 0) {
      const first = arr[0];
      if (typeof first === 'string') return first;
      if (first && typeof first === 'object') {
        if (typeof first.text === 'string') return first.text;
        if (typeof first.translation === 'string') return first.translation;
        if (typeof first.translated_text === 'string') return first.translated_text;
      }
    }
  }

  return '';
}

async function generatePDFBooklet(res, { englishLetter, results, docketNo, attachment }) {
  const doc = new PDFDocument({ margin: 50, size: 'A4' });

  // Set response headers for download
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=Petition_${docketNo}.pdf`);
  doc.pipe(res);

  // FONT CONFIGURATION:
  // You MUST have a Unicode font file (like NotoSans-Regular.ttf) in a /fonts folder
  // to render Tamil/Hindi. Fallback to Helvetica for English.
  const fontPath = path.join(__dirname, 'fonts', 'NotoSans-Regular.ttf');
  const hasFont = require('fs').existsSync(fontPath);

  const writeText = (text, options = {}) => {
    if (hasFont) doc.font(fontPath);
    doc.text(text, options);
  };

  // --- PAGE 1: INTRODUCTION ---
  doc.fontSize(22).text('JAN AWAAZ — जन आवाज़', { align: 'center' });
  doc.moveDown();
  doc.fontSize(12).text(`Docket No: ${docketNo}`, { weight: 'bold' });
  doc.moveDown(2);
  doc.fontSize(11).lineGap(4).text('This document contains the original petition and supporting materials submitted for grievance redressal.');
  doc.moveDown();
  doc.text('The original petition is the authentic version drafted by the complainant.');
  doc.moveDown();
  doc.text('Machine‑generated translations are provided for administrative convenience in regional and Hindi languages.');
  doc.moveDown();
  doc.text('Annexures include any supporting documents attached by the complainant.');
  doc.moveDown(3);
  doc.fillColor('red').text('Disclaimer:', { underline: true });
  doc.fillColor('black').text('Translations are machine‑generated. Accuracy is not guaranteed. They must always be read in tandem with the original petition. Only the citizen’s original draft is legally binding.');

  // --- PAGE 2: TABLE OF CONTENTS ---
  doc.addPage();
  doc.fontSize(18).text('Table of Contents', { underline: true });
  doc.moveDown();
  doc.fontSize(12).fillColor('blue');
  
  doc.text('1. Original Petition (English) ............................. Page 3', { link: 'P3', underline: true });
  doc.moveDown();
  
  let currentPage = 4;
  results.forEach((res) => {
    if (res.language !== 'English') {
      doc.text(`${currentPage-2}. ${res.language} Translation ............................. Page ${currentPage}`, { link: `P${currentPage}`, underline: true });
      res.pageRef = `P${currentPage}`;
      currentPage++;
    }
  });

  if (attachment) {
    doc.moveDown();
    doc.text(`${currentPage-2}. Annexures & Exhibits ............................. Page ${currentPage}`, { link: 'PANNEX', underline: true });
  }
  doc.fillColor('black');

  // --- PAGE 3: ENGLISH ORIGINAL ---
  doc.addPage();
  doc.addNamedDestination('P3');
  doc.fontSize(14).text('Original Petition (English)', { underline: true });
  doc.moveDown();
  doc.fontSize(10).font('Helvetica').text(englishLetter);

  // --- TRANSLATION PAGES ---
  for (const res of results) {
    if (res.language === 'English') continue;
    doc.addPage();
    if (res.pageRef) doc.addNamedDestination(res.pageRef);
    
    // Header watermark-style disclaimer
    doc.fontSize(8).fillColor('grey').text('[ MACHINE GENERATED TRANSLATION - FOR REFERENCE ONLY ]', { align: 'center' });
    doc.moveDown();
    
    doc.fillColor('black').fontSize(14).text(`${res.language} Translation`, { underline: true });
    doc.moveDown();
    
    // Use Unicode font for content
    doc.fontSize(10);
    if (hasFont) doc.font(fontPath);
    doc.text(res.letter);
    
    // Footer disclaimer
    doc.moveDown(2);
    doc.fontSize(8).fillColor('grey').text('Note: This is an automated translation. Please refer to the English version on Page 3 for legal accuracy.');
  }

  // --- ANNEXURES ---
  if (attachment) {
    doc.addPage();
    doc.addNamedDestination('PANNEX');
    doc.fillColor('black').fontSize(14).text('Annexures and Exhibits', { underline: true });
    doc.moveDown();
    
    if (attachment.mimetype.startsWith('image/')) {
      try {
        doc.image(attachment.buffer, {
          fit: [500, 600],
          align: 'center',
          valign: 'center'
        });
      } catch (err) {
        doc.text('Error rendering attachment image.');
      }
    } else {
      doc.text(`Attached file: ${attachment.originalname} (${attachment.mimetype})`);
      doc.text('Note: PDF/Document merging requires additional server-side processing.');
    }
  }

  doc.end();
}

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
    try {
      details = await translationResponse.text();
    } catch (_e) {}
    throw new Error(`Translation failed (${translationResponse.status})${details ? `: ${details}` : ''}`);
  }

  const translated = await parseTranslationResponse(translationResponse);
  return translated;
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
// Body (multipart/form-data):
//   state, department, petitioner, complaint, languages[] (repeated field)
//   attachment (optional file)
app.post(
  '/api/generate-petition',
  upload.single('attachment'),
  async (req, res) => {
    const { state, department, petitioner, complaint } = req.body;

    // languages comes as "Hindi,Tamil,English" or as a repeated field
    let languages = req.body['languages[]'] || req.body.languages || [];
    if (typeof languages === 'string') languages = languages.split(',');
    if (!Array.isArray(languages)) languages = [languages];

    // Always include Hindi
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

      // 1. Generate a professional base petition in English via Template
      const englishLetter = generateBaseEnglishLetter({ state, department, petitioner, complaint, today });

      // Fetch supported languages from local translation service
      let supportedLanguages = [];
      try {
        const langRes = await fetchWithTimeout(`${TRANSLATION_API_URL}/languages`, {}, LANGUAGES_TIMEOUT_MS);
        const langData = await langRes.json();
        supportedLanguages = langData.supported_languages || [];
      } catch (e) {
        console.warn('Translation service languages endpoint unreachable, using fallback logic');
      }

      // 2. Translate to all requested languages sequentially via local service
      // Processing sequentially prevents overloading local CPU/GPU resources
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
          results.push({
            language,
            letter: englishLetter,
            error: err.message || 'Translation failed'
          });
        }
      }

      // If the user requested PDF format (based on a query param or header)
      if (req.query.format === 'pdf') {
        return await generatePDFBooklet(res, { 
          englishLetter, results, docketNo, attachment: req.file 
        });
      }

      // Otherwise return JSON as usual (allows frontend to show preview)
      res.json({ letters: results, docketNo });
    } catch (err) {
      console.error('Processing error:', err.message);
      res.status(500).json({ error: 'Failed to generate or translate petition. ' + err.message });
    }
  }
);

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// ── Local Letter Generator (No Auth Needed) ───────────────────────────────────
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
