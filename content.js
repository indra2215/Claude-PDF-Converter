/**
 * MarkPDF — Content Script
 * Runs on claude.ai. Intercepts PDF paste/upload, converts to Markdown.
 *
 * Pipeline:
 *   1. pdf.js extracts embedded text (fast, no network)
 *   2. If text yield is too low → detected as image/scanned PDF
 *   3. OCR path: pdf.js renders each page as canvas → Tesseract.js reads pixels
 *   4. Result injected into Claude's input editor
 */

(function () {
  "use strict";

  // ─── Sanity checks ────────────────────────────────────────────────────────────
  if (typeof pdfjsLib === "undefined") {
    console.error("[MarkPDF] pdf.js not loaded. Extension may be broken.");
    return;
  }

  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
    "lib/pdf.worker.min.js"
  );

  // ─── Constants ────────────────────────────────────────────────────────────────
  const MIN_CHARS_PER_PAGE = 80; // below this → treat page as image-based
  const OCR_SCALE = 2.0;         // render scale for OCR (higher = better accuracy, slower)
  const TESSERACT_LANGS = "eng"; // change to "eng+hin" for Hindi etc.

  // ─── State ────────────────────────────────────────────────────────────────────
  let activeToast = null;
  let tesseractWorker = null;

  // ─── Tesseract worker (lazy init) ─────────────────────────────────────────────
  async function getTesseractWorker() {
    if (tesseractWorker) return tesseractWorker;

    // Tesseract.js 5.x createWorker API
    tesseractWorker = await Tesseract.createWorker(TESSERACT_LANGS, 1, {
      workerPath: chrome.runtime.getURL("lib/tesseract.worker.min.js"),
      // Language data is downloaded from CDN on first use (~4MB, cached by browser)
      langPath: "https://cdn.jsdelivr.net/npm/tesseract.js-data@4.0.0/traineddata/best",
      cacheMethod: "write",
      logger: (m) => {
        if (m.status === "recognizing text") {
          updateOcrProgress(m.progress);
        }
      },
    });

    return tesseractWorker;
  }

  // ─── PDF Text Extraction (embedded text path) ─────────────────────────────────
  async function extractEmbeddedText(pdf) {
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      pages.push({ pageNum: i, items: content.items });
    }
    return pages;
  }

  function itemsToLines(items) {
    if (!items.length) return [];

    // Sort by Y (descending = top to bottom), then X
    const sorted = items.slice().sort((a, b) => {
      const yDiff = b.transform[5] - a.transform[5];
      return Math.abs(yDiff) > 3 ? yDiff : a.transform[4] - b.transform[4];
    });

    const lines = [];
    let curY = null;
    let curLine = [];

    for (const item of sorted) {
      if (!item.str?.trim()) continue;
      const y = Math.round(item.transform[5]);
      if (curY === null || Math.abs(y - curY) > 4) {
        if (curLine.length) lines.push(curLine.join(" ").trim());
        curLine = [];
        curY = y;
      }
      curLine.push(item.str);
    }
    if (curLine.length) lines.push(curLine.join(" ").trim());
    return lines;
  }

  function linesToMarkdown(lines, pageNum, totalPages) {
    const mdLines = lines.map((line) => {
      const t = line.trim();
      if (!t) return "";

      const words = t.split(/\s+/);
      const wc = words.length;
      const noEndPunct = !/[.,:;?!]$/.test(t);
      const isAllCaps = t === t.toUpperCase() && /[A-Z]{2,}/.test(t);
      const titleRatio = words.filter((w) => /^[A-Z]/.test(w)).length / wc;

      if (wc <= 10 && noEndPunct) {
        if (isAllCaps && wc <= 6) return `## ${t}`;
        if (titleRatio > 0.65 && wc <= 7) return `### ${t}`;
      }

      // Bullet symbols
      if (/^[\u2022\u2023\u25E6\u2043\u00B7\-\*]\s/.test(t))
        return `- ${t.slice(2).trim()}`;

      // Numbered list
      if (/^\d+[\.\)]\s/.test(t)) return t;

      return t;
    });

    const body = mdLines.filter(Boolean).join("\n");
    if (totalPages > 1) {
      return `\n---\n*— Page ${pageNum} —*\n\n${body}`;
    }
    return body;
  }

  // ─── OCR path (image/scanned PDFs) ───────────────────────────────────────────
  async function ocrPage(pdf, pageNum) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: OCR_SCALE });

    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");

    await page.render({ canvasContext: ctx, viewport }).promise;

    const worker = await getTesseractWorker();
    const result = await worker.recognize(canvas);

    // Clean up OCR noise
    const text = result.data.text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join("\n");

    canvas.remove();
    return text;
  }

  // ─── Master conversion function ───────────────────────────────────────────────
  async function convertPdfToMarkdown(arrayBuffer, fileName, onProgress) {
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const totalPages = pdf.numPages;

    onProgress({ stage: "extracting", page: 0, total: totalPages });

    // Step 1: Extract embedded text
    const pageData = await extractEmbeddedText(pdf);

    // Step 2: Decide per-page whether OCR is needed
    const results = [];
    let ocrPageCount = 0;

    for (const { pageNum, items } of pageData) {
      const embeddedText = items.map((i) => i.str).join("").trim();
      const needsOcr = embeddedText.length < MIN_CHARS_PER_PAGE;

      if (needsOcr) {
        ocrPageCount++;
        onProgress({ stage: "ocr", page: pageNum, total: totalPages, ocrPage: ocrPageCount });
        try {
          const ocrText = await ocrPage(pdf, pageNum);
          results.push({
            pageNum,
            text: ocrText,
            method: "ocr",
            confidence: ocrText.length > 50 ? "medium" : "low",
          });
        } catch (err) {
          results.push({
            pageNum,
            text: `*[Page ${pageNum}: OCR failed — ${err.message}]*`,
            method: "ocr_failed",
            confidence: "none",
          });
        }
      } else {
        const lines = itemsToLines(items);
        results.push({
          pageNum,
          text: linesToMarkdown(lines, pageNum, totalPages),
          method: "embedded",
          confidence: "high",
        });
      }
    }

    // Step 3: Assemble final Markdown
    const baseName = fileName.replace(/\.pdf$/i, "");
    const hasMixedPages = results.some((r) => r.method === "ocr");
    const hasLowConf = results.some((r) => r.confidence === "low");

    let header = `# ${baseName}\n`;
    if (hasMixedPages) {
      header += `\n> ⚠️ **Note:** ${ocrPageCount} page(s) were image-based and processed via OCR.\n`;
      header += `> OCR accuracy depends on scan quality. **Verify critical content before use.**\n`;
    }
    if (hasLowConf) {
      header += `> ⚠️ Some pages returned very little text — they may be handwritten, low-quality scans, or purely graphical.\n`;
    }

    const body = results.map((r) => r.text).join("\n\n");
    const fullMd = `${header}\n${body}`.replace(/\n{3,}/g, "\n\n").trim();

    return {
      markdown: fullMd,
      stats: {
        totalPages,
        ocrPages: ocrPageCount,
        embeddedPages: totalPages - ocrPageCount,
        hasLowConfidence: hasLowConf,
      },
    };
  }

  // ─── Inject into Claude's editor ─────────────────────────────────────────────
  function injectIntoClaudeEditor(mdText, fileName) {
    const selectors = [
      'div[contenteditable="true"].ProseMirror',
      '[data-testid="composer-input"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
    ];

    let editor = null;
    for (const sel of selectors) {
      editor = document.querySelector(sel);
      if (editor) break;
    }

    const label = `*[Converted from: ${fileName.replace(/\.pdf$/i, "")}]*\n\n`;
    const fullText = label + mdText;

    if (editor) {
      editor.focus();
      const inserted = document.execCommand("insertText", false, fullText);
      if (!inserted) {
        // Fallback for browsers where execCommand is disabled
        editor.innerText = fullText;
        editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
      }
    } else {
      // Ultimate fallback: clipboard
      navigator.clipboard.writeText(fullText).then(() => {
        showSimpleToast("📋 Copied to clipboard — paste with Ctrl+V");
      });
    }
  }

  // ─── UI: Toast system ────────────────────────────────────────────────────────
  function removeToast() {
    if (!activeToast) return;
    activeToast.classList.remove("mpdf-visible");
    activeToast.classList.add("mpdf-exit");
    const t = activeToast;
    activeToast = null;
    setTimeout(() => t?.remove(), 320);
  }

  function makeToast(html, autoClose = 0) {
    removeToast();
    const el = document.createElement("div");
    el.className = "mpdf-toast";
    el.innerHTML = html;
    document.body.appendChild(el);
    activeToast = el;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => el.classList.add("mpdf-visible"));
    });
    if (autoClose) setTimeout(removeToast, autoClose);
    return el;
  }

  function showDetectedToast(fileName, size, onConvert) {
    const toast = makeToast(`
      <div class="mpdf-icon mpdf-icon-pdf">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14,2 14,8 20,8"/>
        </svg>
      </div>
      <div class="mpdf-body">
        <div class="mpdf-title">${esc(fileName)}</div>
        <div class="mpdf-sub">${fmtBytes(size)} · PDF detected</div>
      </div>
      <button class="mpdf-btn mpdf-btn-primary" id="mpdf-convert">⚡ Convert to .md</button>
      <button class="mpdf-btn mpdf-btn-ghost" id="mpdf-skip">✕</button>
    `, 14000);

    toast.querySelector("#mpdf-convert").onclick = () => { removeToast(); onConvert(); };
    toast.querySelector("#mpdf-skip").onclick = removeToast;
  }

  function showProcessingToast(fileName, info) {
    makeToast(`
      <div class="mpdf-icon mpdf-icon-spin">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="23,4 23,10 17,10"/>
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
        </svg>
      </div>
      <div class="mpdf-body">
        <div class="mpdf-title">${esc(fileName)}</div>
        <div class="mpdf-sub" id="mpdf-progress-label">${esc(info)}</div>
      </div>
    `);
  }

  function updateOcrProgress(p) {
    const el = document.getElementById("mpdf-progress-label");
    if (el) el.textContent = `OCR in progress… ${Math.round(p * 100)}%`;
  }

  function showDoneToast(fileName, stats, mdText) {
    const savedPct = mdText.length < 5000 ? null :
      Math.max(0, Math.round((1 - (new TextEncoder().encode(mdText).length / (mdText.length * 2))) * 100));

    const ocrNote = stats.ocrPages > 0
      ? `<span class="mpdf-badge mpdf-badge-warn">OCR: ${stats.ocrPages}p</span>` : "";
    const lowNote = stats.hasLowConfidence
      ? `<span class="mpdf-badge mpdf-badge-danger">Low confidence</span>` : "";

    const toast = makeToast(`
      <div class="mpdf-icon mpdf-icon-done">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="20,6 9,17 4,12"/>
        </svg>
      </div>
      <div class="mpdf-body">
        <div class="mpdf-title">${esc(fileName.replace(/\.pdf$/i, ".md"))}</div>
        <div class="mpdf-sub">
          ${stats.totalPages}p · ~${Math.round(mdText.length / 4).toLocaleString()} tokens
          ${ocrNote}${lowNote}
        </div>
      </div>
      <button class="mpdf-btn mpdf-btn-primary" id="mpdf-insert">Insert into Claude</button>
      <button class="mpdf-btn mpdf-btn-ghost" id="mpdf-done-close">✕</button>
    `);

    toast.querySelector("#mpdf-insert").onclick = () => {
      injectIntoClaudeEditor(mdText, fileName);
      removeToast();
    };
    toast.querySelector("#mpdf-done-close").onclick = removeToast;
  }

  function showErrorToast(message) {
    makeToast(`
      <div class="mpdf-icon mpdf-icon-error">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
      </div>
      <div class="mpdf-body">
        <div class="mpdf-title">Conversion failed</div>
        <div class="mpdf-sub">${esc(message)}</div>
      </div>
      <button class="mpdf-btn mpdf-btn-ghost" id="mpdf-err-close">✕</button>
    `, 7000);
    document.getElementById("mpdf-err-close")?.addEventListener("click", removeToast);
  }

  function showSimpleToast(msg) {
    makeToast(`<div class="mpdf-body"><div class="mpdf-title">${esc(msg)}</div></div>`, 4000);
  }

  // ─── Main handler ─────────────────────────────────────────────────────────────
  async function handlePdf(file) {
    if (!file || file.type !== "application/pdf") return false;
    const { name: fileName, size } = file;

    showDetectedToast(fileName, size, async () => {
      showProcessingToast(fileName, "Reading PDF structure…");

      try {
        const buffer = await file.arrayBuffer();
        const { markdown, stats } = await convertPdfToMarkdown(
          buffer,
          fileName,
          ({ stage, page, total, ocrPage }) => {
            const label = document.getElementById("mpdf-progress-label");
            if (!label) return;
            if (stage === "extracting") {
              label.textContent = `Extracting text… page ${page}/${total}`;
            } else if (stage === "ocr") {
              label.textContent = `OCR page ${page}/${total} (image-based)…`;
            }
          }
        );
        showDoneToast(fileName, stats, markdown);
      } catch (err) {
        console.error("[MarkPDF]", err);
        const msg = err.message?.includes("password")
          ? "PDF is password-protected — cannot extract"
          : err.message?.includes("Invalid PDF")
          ? "File does not appear to be a valid PDF"
          : err.message || "Unexpected error";
        showErrorToast(msg);
      }
    });

    return true;
  }

  // ─── Event hooks ─────────────────────────────────────────────────────────────

  // Paste
  document.addEventListener("paste", async (e) => {
    for (const item of Array.from(e.clipboardData?.items || [])) {
      if (item.kind === "file" && item.type === "application/pdf") {
        e.preventDefault();
        e.stopImmediatePropagation();
        await handlePdf(item.getAsFile());
        return;
      }
    }
  }, { capture: true }); // Intercept early before Claude handles paste

  // File input (upload button)
  function patchFileInput(input) {
    if (input.__mpdfPatched) return;
    input.__mpdfPatched = true;
    input.addEventListener("change", async (e) => {
      let hasPdf = false;
      for (const f of Array.from(e.target.files || [])) {
        if (f.type === "application/pdf") {
          hasPdf = true;
          await handlePdf(f);
        }
      }
      
      if (hasPdf) {
        e.preventDefault();
        e.stopImmediatePropagation();
        input.value = ""; // Clear file input so Claude doesn't read it
      }
    }, { capture: true });
  }

  document.querySelectorAll('input[type="file"]').forEach(patchFileInput);

  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === "INPUT" && node.type === "file") patchFileInput(node);
        node.querySelectorAll?.('input[type="file"]').forEach(patchFileInput);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  // Drag & drop
  document.addEventListener("drop", async (e) => {
    let hasPdf = false;
    for (const f of Array.from(e.dataTransfer?.files || [])) {
      if (f.type === "application/pdf") {
        hasPdf = true;
        await handlePdf(f);
      }
    }

    if (hasPdf) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, { capture: true });

  // Prevent default dragover to allow drop
  document.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      // Need to find if it's a PDF, wait we can't inspect files during dragover easily.
      // Easiest is just to let it pass but stop it if we want to drop it.
      // Usually stopPropagation on drop is enough.
    }
  }, { capture: true });

  // ─── Helpers ─────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function fmtBytes(b) {
    if (b < 1024) return b + " B";
    if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
    return (b / 1048576).toFixed(1) + " MB";
  }

  console.log("[MarkPDF] Loaded on", location.hostname);
})();
