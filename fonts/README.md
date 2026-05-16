## Fonts for Indian languages (PDF rendering)

This project uses **PDFKit** to generate PDFs. PDFKit will **embed** fonts into the PDF automatically **when you use a `.ttf`/`.otf` font file** via `doc.registerFont()` / `doc.font()`.

To render Indian scripts correctly (Hindi, Tamil, Telugu, etc.), you must place suitable Unicode fonts in this `fonts/` folder.

### Recommended (Google Noto fonts)

Download the Regular `.ttf` files and place them here with these exact names:

- `NotoSansDevanagari-Regular.ttf` (Hindi/Marathi/Nepali/Sanskrit/etc.)
- `NotoSansTamil-Regular.ttf`
- `NotoSansTelugu-Regular.ttf`
- `NotoSansKannada-Regular.ttf`
- `NotoSansMalayalam-Regular.ttf`
- `NotoSansBengali-Regular.ttf` (Bengali/Assamese)
- `NotoSansGujarati-Regular.ttf`
- `NotoSansGurmukhi-Regular.ttf` (Punjabi)
- `NotoSansOriya-Regular.ttf` (Odia)
- `NotoNaskhArabic-Regular.ttf` (Urdu/Sindhi/Kashmiri)
- `NotoSansSinhala-Regular.ttf` (Sinhala, if needed)

If you only want one fallback font, you can also try:
- `NotoSans-Regular.ttf`

### How it’s used

`server.js` selects a font per language (and falls back when a font file is missing). If no font is found, PDFKit falls back to `Helvetica`, which will **not** render most Indian scripts correctly.

