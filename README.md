<div align="center">
  <img src="icons/icon128.png" alt="Claude PDF Converter Logo" width="128" style="border-radius: 20px;"/>
  <h1>⚡ Claude PDF Converter</h1>
  <p><strong>Transform PDFs into clean, token-efficient Markdown and attach them directly inside Claude.ai</strong></p>
  <p>
    <img alt="Platform" src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue"/>
    <img alt="Manifest" src="https://img.shields.io/badge/Manifest-V3-green"/>
    <img alt="Version" src="https://img.shields.io/badge/Version-1.2.0-orange"/>
  </p>
  <br/>
</div>

## 🚀 Why Use This?

When you upload a raw PDF to Claude, it processes it as a heavy binary document — eating up your token limits fast and reducing reliability for structured reasoning.

**Claude PDF Converter** converts your PDF to lightweight Markdown locally, then attaches the `.md` file directly into your Claude chat — saving massive amounts of tokens.

| Format | Tokens (typical 10-page doc) |
|--------|-------------------------------|
| 🛑 **Raw PDF (uploaded)** | ~8,000–15,000 |
| ✅ **Converted Markdown (.md file)** | ~2,000–5,000 |
| 📉 **Total Savings** | **~50–75% Tokens Saved** |

No server. No API key. **No data ever leaves your machine.**

---

## ✨ Features

- 📑 **Instant Text Extraction** — Uses pdf.js for blazing-fast local PDF parsing.
- 👁️ **Smart OCR Built-in** — Auto-detects image-based/scanned PDFs and extracts text via Tesseract.js.
- 📎 **Attaches as .md File** — Converted Markdown is attached as a `.md` file directly into Claude's chat (not pasted as raw text).
- 📦 **FIFO Queue System** — Paste, drop, or upload multiple PDFs at once. They are safely queued and processed sequentially with zero state collisions.
- ⏳ **Persistent Toast Prompts** — The conversion dialog remains visible indefinitely until you interact with it, eliminating automatic dismissals.
- ⌨️ **Seamless Integration** — Triggers automatically on paste (Ctrl+V), drag-and-drop, or file upload on Claude.ai.
- 📊 **Token Estimation** — See estimated token count before sending to Claude.
- 🔒 **100% Private** — Everything runs in your browser. Zero network calls after initial OCR language model download.
- 🖥️ **Cross-Platform** — Works on **Windows**, **macOS**, and **Linux** — any OS that runs Chromium-based browsers.
- ♿ **Accessible** — Toast notifications include ARIA roles for screen reader support.
- 🧹 **Memory Efficient** — OCR worker auto-terminates after 60 seconds of inactivity to free resources.

---

## 🛠️ How to Install

> *Install in 30 seconds — no build tools required. Works on Windows, macOS, and Linux.*

1. **Download:** Click the green `<> Code` button at the top of this repository and select **Download ZIP** (or clone the repo).
2. **Extract:** Unzip the downloaded file to a folder on your computer.
3. **Open Extensions:**
   - **Chrome:** Navigate to `chrome://extensions/`
   - **Edge:** Navigate to `edge://extensions/`
   - **Brave:** Navigate to `brave://extensions/`
4. **Developer Mode:** Toggle **Developer mode** **ON** (top-right corner).
5. **Load Extension:** Click **Load unpacked** and select the extracted `Claude-PDF-Converter` folder.
6. **Done!** Navigate to [claude.ai](https://claude.ai) — the extension is now active.

---

## 📖 How to Use

1. Open a chat on **[claude.ai](https://claude.ai)**.
2. **Paste** a PDF (`Ctrl+V` / `Cmd+V`), **drag and drop** it, or use Claude's **upload button**.
3. A notification appears just above the chat input area.
4. Click **"⚡ Convert to .md"**.
   - *Text PDFs convert in <1 second.*
   - *Image/scanned PDFs run OCR (first use downloads a ~4MB language model, cached afterward).*
5. Click **"📎 Attach .md to Claude"** — the converted Markdown file is attached directly to your chat as a `.md` file.

> **Tip:** If file attachment is unavailable, the extension falls back to inserting text directly into the editor, or copying to your clipboard.

---

## ⚠️ Accuracy & Limitations

| Scenario | Notes |
|----------|-------|
| **Complex layouts** | Tables and multi-column layouts are flattened. Verify columns merged correctly. |
| **Scanned documents** | OCR quality depends on scan resolution and clarity. |
| **Handwritten text** | Tesseract is not trained for handwriting — results will be unreliable. |
| **Password-protected PDFs** | Cannot be processed. You'll see a clear error message. |
| **Very large PDFs (50+ pages)** | OCR path may be slow. Text-based PDFs process instantly regardless of size. |

---

## 🔧 Technical Details

### Architecture

```
PDF Input (paste / drop / upload)
       │
       ▼
   pdf.js — Extract embedded text
       │
       ├── Text found? → Markdown conversion (instant)
       │
       └── Image-based? → Tesseract.js OCR → Markdown
                               │
                               ▼
                   .md File created via DataTransfer API
                               │
                               ▼
                  Attached to Claude's chat input
```

### Key Design Decisions

- **File attachment over text insertion** — The `.md` file is attached using the `DataTransfer` API and simulated drop events, making Claude treat it as a proper file attachment.
- **Multi-method fallback** — Drop simulation → File input injection → Text insertion → Clipboard copy.
- **Toast positioning** — Notifications appear just above Claude's input area (not at the top of the screen) for better contextual UX.
- **Memory management** — The Tesseract OCR worker is lazily initialized and auto-terminated after 60 seconds of inactivity.
- **Event interception** — All paste/drop/change handlers run in capture phase to intercept PDFs before Claude processes them. An `isInjectingFile` flag prevents the extension from intercepting its own synthetic events.

### Browser Compatibility

| Browser | Platform | Status |
|---------|----------|--------|
| Google Chrome | Windows, macOS, Linux | ✅ Fully supported |
| Microsoft Edge | Windows, macOS, Linux | ✅ Fully supported |
| Brave | Windows, macOS, Linux | ✅ Fully supported |
| Arc | macOS | ✅ Fully supported |
| Other Chromium-based | All | ✅ Should work |
| Firefox / Safari | — | ❌ Not supported (Manifest V3 only) |

---

## 🛡️ Privacy & Security

- **Zero data transmission** — Your PDFs are processed entirely in your browser using JavaScript.
- **CDN usage** — The extension contacts `cdn.jsdelivr.net` **only once** on first OCR use to download the open-source Tesseract language model (~4MB). This is cached locally afterward.
- **No analytics, no tracking, no telemetry.**
- **XSS hardened** — All user-supplied strings (filenames, messages) are HTML-escaped before rendering, including single quotes.

---

## 📋 Changelog

### v1.2.0 (Latest)

- **📦 FIFO Queue System** — Dropping or uploading multiple PDFs now adds them to a first-in, first-out sequence list, processing them one-by-one with zero state collisions.
- **⏳ Persistent Toast UX** — Removed the 14-second auto-close timeout from the PDF detection toast, ensuring it stays active until manual interaction.
- **📎 File attachment** — Converted Markdown is now attached as a `.md` file instead of pasted as raw text.
- **🎯 Toast repositioning** — Notifications now appear above the chat input area, not at the top of the page.
- **🐛 Fixed drag-and-drop** — `preventDefault()` now runs synchronously before async processing.
- **🐛 Fixed dragover handler** — Added missing `preventDefault()` required for custom drop handling.
- **🐛 Fixed CSS animation** — Toast centering no longer breaks during entrance animation.
- **🧹 Memory leak fix** — Tesseract OCR worker now auto-terminates after 60 seconds idle.
- **🛡️ XSS hardening** — `esc()` function now escapes single quotes.
- **♿ Accessibility** — Added `role="alert"` and `aria-live="polite"` to toast notifications.
- **🎨 New icons** — Fresh, modern extension icons.
- **🗑️ Removed dead code** — Unused `savedPct` computation removed.

### v1.1.0

- Initial release with PDF text extraction and OCR support.

---

<div align="center">
  <i>Built to make AI more accessible and efficient.</i>
</div>
