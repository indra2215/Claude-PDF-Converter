# ⚡ Claude PDF Converter

> Paste or upload any PDF on [claude.ai](https://claude.ai) and instantly convert it to token-efficient Markdown — right in your browser. No server. No API key. No data leaves your machine.

---

## Why This Exists

When you upload a PDF directly to Claude, it is processed as a binary document — expensive in tokens and less reliable for structured reasoning. Plain Markdown is dramatically cheaper and cleaner:

| Format | Tokens (typical 10-page doc) |
|--------|-------------------------------|
| PDF (uploaded) | ~8,000–15,000 |
| Converted Markdown | ~2,000–5,000 |
| **Savings** | **~50–75%** |

Claude PDF Converter intercepts your PDF before it reaches Claude and converts it to Markdown in your browser using [pdf.js](https://github.com/mozilla/pdf.js) and [Tesseract.js](https://github.com/naptha/tesseract.js).

---

## Features

- **Text-based PDFs** — extracted instantly via pdf.js (no network call)
- **Image/scanned PDFs** — auto-detected and OCR'd via Tesseract.js
- **Mixed PDFs** — text pages use fast extraction; image pages use OCR
- **Three trigger paths** — paste (Ctrl+V), file upload button, drag & drop
- **Token estimate shown** before you insert
- **Injects directly** into Claude's editor (preserves undo history)
- **100% local** — Tesseract language data cached in browser after first use

---

## Installation

> Install manually:

1. Clone or download this repo \https://github.com/indra2215/Claude-PDF-Converter.git\
2. Unzip it
3. Open Chrome → go to \chrome://extensions/\
4. Toggle **Developer mode** ON (top right)
5. Click **Load unpacked** → select the folder
6. Navigate to [claude.ai](https://claude.ai) — the extension is now active

---

## How to Use

\\\
1. On claude.ai, press Ctrl+V with a PDF in clipboard
   OR click Claude's file upload button and select a PDF
   OR drag and drop a PDF onto the page

2. A toast notification appears at the top center of the page

3. Click "⚡ Convert to .md"
   → Text PDFs: converts in <1 second
   → Image/scanned PDFs: OCR runs (first use downloads ~4MB language model, cached after)

4. Click "Insert into Claude" — Markdown is typed into the chat box

5. Send your message as usual
\\\

---

## ⚠️ Accuracy Caveats — Read Before Using

This tool does its best, but has hard limits you must know:

### Text-based PDFs
- Works well for clean, single-column documents
- **Tables** are flattened — PDF has no table semantics, so columns may merge incorrectly
- **Multi-column layouts** (e.g. academic papers, newspapers) may have incorrect reading order
- Mathematical formulas rendered as vector graphics are lost

### Image-based / Scanned PDFs
- OCR accuracy depends entirely on **scan quality and resolution**
- Clean, high-contrast scans: good results
- Low-quality scans, skewed pages, watermarks: degraded results
- **Accuracy is not guaranteed — always verify output**

### Handwritten PDFs
- **Tesseract is not trained for handwriting**
- Handwritten content will produce garbled or empty output

### What to Do With Low-Confidence Output
The extension shows a warning badge when output confidence is low. In those cases:
- Use a dedicated OCR tool (Adobe Acrobat, ABBYY FineReader, Google Drive's OCR)
- Or use Mathpix for math-heavy documents

---

## Privacy

- **Zero network requests** for text-based PDFs
- For image-based PDFs: Tesseract downloads \eng.traineddata\ (~4MB) from jsDelivr CDN on first use. This is the language model file. **No document content is ever sent anywhere.**

---

## License

MIT — see [LICENSE](LICENSE)
