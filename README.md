<div align="center">
  <img src="icons/icon128.png" alt="Claude PDF Converter Logo" width="128" style="border-radius: 20px;"/>
  <h1>⚡ Claude PDF Converter</h1>
  <p><strong>A Local Client Application to Transform PDFs into clean, token-efficient Markdown directly inside Claude.ai</strong></p>
  <br/>
</div>

## 🚀 Why Use This Local Application?

When you upload a direct PDF to Claude, it processes it as a heavy binary document. This eats up your token limits fast and is less reliable for structured reasoning. 

By converting it to plain Markdown locally *before* Claude reads it, you save massive amounts of limits!

| Format | Tokens (typical 10-page doc) |
|--------|-------------------------------|
| 🛑 **Raw PDF (uploaded)** | ~8,000–15,000 |
| ✅ **Converted Markdown** | ~2,000–5,000 |
| 📉 **Total Savings** | **~50–75% Tokens Saved** |

No server. No API key. **No data ever leaves your machine.**

---

## ✨ Features

- 📑 **Instant Text Extraction** — Uses pdf.js for blazing-fast local processing.
- 👁️ **Smart OCR Built-in** — Auto-detects scanned images and extracts text via Tesseract.js.
- ⌨️ **Seamless Integration** — Triggers automatically when you paste (Ctrl+V), drag-and-drop, or click the upload button on Claude.ai.
- 📊 **Token Estimation** — See the size of your document *before* you send it to Claude.
- 🔒 **100% Private** — Everything happens in your browser. Zero network calls after initial OCR language model download.

---

## 🛠️ How to Install

> *Note: By installing this browser application locally, you guarantee 100% data privacy. Easily install it manually in 30 seconds!*

1. **Download the Application:** Click the green `<> Code` button at the top of this repository and select **Download ZIP** (or clone the repo).
2. **Extract:** Unzip the downloaded file to a folder on your computer.
3. **Open Extensions:** Open Google Chrome and go to chrome://extensions/ in your URL bar.
4. **Developer Mode:** Toggle **Developer mode** **ON** at the top right corner.
5. **Load Extension:** Click the **Load unpacked** button at the top left. Select the extracted Claude-PDF-Converter folder.
6. **Done:** Navigate to [Claude.ai](https://claude.ai) and the extension is now active!

---

## 📖 How to Use

1. Open a chat on **[claude.ai](https://claude.ai)**.
2. Select a PDF on your computer and press Ctrl+C, then go to Claude and press Ctrl+V (or simply drag and drop the PDF).
3. A sleek drop-down notification will appear at the top center of your screen.
4. Click **"⚡ Convert to .md"**.
   - *Text PDFs convert in <1 second.*
   - *Image/scanned PDFs will run OCR (first use downloads a ~4MB cache).*
5. Click **"Insert into Claude"**. The lightweight Markdown is instantly typed into your chat!

---

## ⚠️ Accuracy & Limitations

- **Complex Layouts:** Tables and multi-column layouts (like academic papers) are flattened. Verify columns are merged correctly.
- **Scanned Documents:** OCR quality heavily depends on the scan resolution.
- **Handwriting:** The OCR engine (Tesseract) is not trained for handwritten notes.

---

## 🛡️ Privacy & Tech Stack

Built for Manifest V3. Your PDF never leaves your computer. The extension solely communicates with cdn.jsdelivr.net to cache the open-source OCR language models locally on first use. All PDF parsing is achieved via client-side JavaScript.

<div align="center">
  <i>Built to make AI more accessible and efficient.</i>
</div>
