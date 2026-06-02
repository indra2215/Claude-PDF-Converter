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
  let workerIdleTimer = null;
  let isInjectingFile = false; // flag to bypass our own event interceptors during .md injection
  let pdfQueue = [];
  let isProcessingQueue = false;

  // ─── Tesseract worker (lazy init, auto-cleanup after 60s idle) ────────────────
  function scheduleWorkerCleanup() {
    clearTimeout(workerIdleTimer);
    workerIdleTimer = setTimeout(async () => {
      if (tesseractWorker) {
        await tesseractWorker.terminate();
        tesseractWorker = null;
        console.log("[MarkPDF] Tesseract worker terminated (idle timeout)");
      }
    }, 60000);
  }

  async function getTesseractWorker() {
    clearTimeout(workerIdleTimer);
    if (tesseractWorker) return tesseractWorker;

    // Tesseract.js 5.x createWorker API
    tesseractWorker = await Tesseract.createWorker(TESSERACT_LANGS, 1, {
      workerPath: chrome.runtime.getURL("lib/tesseract.worker.min.js"),
      // Language data is downloaded from CDN on first use (~4MB, cached by browser)
      langPath: "https://tessdata.projectnaptha.com/4.0.0",
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

    // Clean up OCR worker after idle period to free memory
    if (ocrPageCount > 0) scheduleWorkerCleanup();

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

  // ─── Inject .md file into Claude ────────────────────────────────────────────────
  function findClaudeEditor() {
    const selectors = [
      'div[contenteditable="true"].ProseMirror',
      '[data-testid="composer-input"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function injectMarkdownFile(mdText, fileName) {
    const mdFileName = fileName.replace(/\.pdf$/i, ".md");
    const file = new File([mdText], mdFileName, {
      type: "text/markdown",
      lastModified: Date.now(),
    });

    // Method 1: Use Claude's file input directly (only reliable way)
    const fileInputs = document.querySelectorAll('input[type="file"]');
    let injected = false;
    
    for (const input of fileInputs) {
      try {
        const dt = new DataTransfer();
        // Preserve existing files in the input list
        if (input.files && input.files.length) {
          for (let i = 0; i < input.files.length; i++) {
            if (input.files[i].name !== mdFileName) {
              dt.items.add(input.files[i]);
            }
          }
        }
        dt.items.add(file);
        isInjectingFile = true;
        input.files = dt.files;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        isInjectingFile = false;
        injected = true;
      } catch (err) {
        isInjectingFile = false;
        continue;
      }
    }

    if (injected) {
      showSimpleToast(`\u2705 ${esc(mdFileName)} attached to Claude`);
      return;
    }

    // Fallback: insert as text in editor
    const editor = findClaudeEditor();
    if (editor) {
      editor.focus();
      const label = `*[Converted from: ${fileName.replace(/\.pdf$/i, "")}]*\n\n`;
      const fullText = label + mdText;
      const inserted = document.execCommand("insertText", false, fullText);
      if (!inserted) {
        editor.innerText = fullText;
        editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
      }
      showSimpleToast("\u270D Inserted as text (file attach unavailable)");
      return;
    }

    // Ultimate fallback: clipboard
    navigator.clipboard.writeText(mdText).then(() => {
      showSimpleToast("\uD83D\uDCCB Copied to clipboard \u2014 paste with Ctrl+V");
    });
  }

  function injectRawPdfFile(file) {
    const fileInputs = document.querySelectorAll('input[type="file"]');
    let injected = false;
    
    for (const input of fileInputs) {
      try {
        const dt = new DataTransfer();
        // Preserve existing files in the input list
        if (input.files && input.files.length) {
          for (let i = 0; i < input.files.length; i++) {
            if (input.files[i].name !== file.name) {
              dt.items.add(input.files[i]);
            }
          }
        }
        dt.items.add(file);
        isInjectingFile = true;
        input.files = dt.files;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        isInjectingFile = false;
        injected = true;
      } catch (err) {
        isInjectingFile = false;
        continue;
      }
    }

    if (injected) {
      showSimpleToast(`\u2705 Original PDF attached: ${esc(file.name)}`);
      return;
    }

    showSimpleToast("\u26A0 Could not attach raw PDF");
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
    el.setAttribute("role", "alert");
    el.setAttribute("aria-live", "polite");
    el.innerHTML = html;
    document.body.appendChild(el);
    activeToast = el;

    // Position toast just above Claude's input area
    positionToastAboveInput(el);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => el.classList.add("mpdf-visible"));
    });
    if (autoClose) setTimeout(removeToast, autoClose);
    return el;
  }

  function positionToastAboveInput(toast) {
    const editor = findClaudeEditor();
    if (editor) {
      // Find the nearest container parent (the composer wrapper)
      const composerArea = editor.closest('[class*="composer"]')
        || editor.closest('[class*="input"]')
        || editor.parentElement;
      const rect = (composerArea || editor).getBoundingClientRect();
      const bottomOffset = window.innerHeight - rect.top + 12;
      toast.style.bottom = `${Math.max(bottomOffset, 80)}px`;
    }
  }

  function showDetectedToast(fileName, size, onConvert) {
    const queueInfo = pdfQueue.length > 1 ? ` · File 1 of ${pdfQueue.length}` : "";
    const toast = makeToast(`
      <div class="mpdf-icon mpdf-icon-pdf">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14,2 14,8 20,8"/>
        </svg>
      </div>
      <div class="mpdf-body">
        <div class="mpdf-title">${esc(fileName)}</div>
        <div class="mpdf-sub">${fmtBytes(size)}${queueInfo} · PDF detected</div>
      </div>
      <button class="mpdf-btn mpdf-btn-primary" id="mpdf-convert">⚡ Convert to .md</button>
      <button class="mpdf-btn mpdf-btn-ghost" id="mpdf-skip">✕</button>
    `, 0);

    toast.querySelector("#mpdf-convert").onclick = () => { onConvert(); };
    toast.querySelector("#mpdf-skip").onclick = () => {
      const originalFile = pdfQueue[0];
      if (originalFile) {
        injectRawPdfFile(originalFile);
      }
      pdfQueue.shift();
      removeToast();
      processNextInQueue();
    };
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
    const mdTokens = Math.round(mdText.length / 4);
    // Rough estimate: Claude charges ~1500 tokens per raw PDF page via vision vs pure text
    const pdfTokensEstimate = stats.totalPages * 1500; 
    const tokensSaved = Math.max(0, pdfTokensEstimate - mdTokens);

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
          ${stats.totalPages}p · ~${mdTokens.toLocaleString()} tokens (Saved ~${tokensSaved.toLocaleString()})
          ${ocrNote}${lowNote}
        </div>
      </div>
      <button class="mpdf-btn mpdf-btn-primary" id="mpdf-insert">📎 Attach .md to Claude</button>
      <button class="mpdf-btn mpdf-btn-ghost" id="mpdf-done-close">✕</button>
    `, 0);

    toast.querySelector("#mpdf-insert").onclick = () => {
      removeToast(); // Remove this toast FIRST, so we don't accidentally remove the success toast
      injectMarkdownFile(mdText, fileName);
      
      pdfQueue.shift();
      setTimeout(processNextInQueue, 1500);
    };
    
    toast.querySelector("#mpdf-done-close").onclick = () => {
      pdfQueue.shift();
      removeToast();
      processNextInQueue();
    };
  }

  function showErrorToast(message, onClose) {
    const toast = makeToast(`
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
    `, 6000);
    
    const closeBtn = toast.querySelector("#mpdf-err-close");
    let closed = false;
    
    const handleClose = () => {
      if (closed) return;
      closed = true;
      removeToast();
      if (onClose) onClose();
    };

    if (closeBtn) closeBtn.onclick = handleClose;
    setTimeout(handleClose, 6000);
  }

  function showSimpleToast(msg) {
    makeToast(`<div class="mpdf-body"><div class="mpdf-title">${esc(msg)}</div></div>`, 4000);
  }

  // ─── Main Queue Handler ────────────────────────────────────────────────────────
  async function processNextInQueue() {
    if (pdfQueue.length === 0) {
      isProcessingQueue = false;
      return;
    }

    isProcessingQueue = true;
    const file = pdfQueue[0];
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
          
        showErrorToast(msg, () => {
          pdfQueue.shift();
          processNextInQueue();
        });
      }
    });
  }

  function updateQueueInfoInToast() {
    if (!activeToast) return;
    const subEl = activeToast.querySelector(".mpdf-sub");
    if (subEl && pdfQueue.length > 0) {
      const file = pdfQueue[0];
      const queueInfo = pdfQueue.length > 1 ? ` · File 1 of ${pdfQueue.length}` : "";
      subEl.innerHTML = `${fmtBytes(file.size)}${queueInfo} · PDF detected`;
    }
  }

  async function handlePdf(file) {
    if (!file || file.type !== "application/pdf") return false;
    
    pdfQueue.push(file);

    if (pdfQueue.length === 1 && !isProcessingQueue) {
      processNextInQueue();
    } else {
      updateQueueInfoInToast();
    }

    return true;
  }

  // ─── Event hooks ─────────────────────────────────────────────────────────────

  // Paste
  document.addEventListener("paste", async (e) => {
    let intercepted = false;
    for (const item of Array.from(e.clipboardData?.items || [])) {
      if (item.kind === "file" && item.type === "application/pdf") {
        if (!intercepted) {
          e.preventDefault();
          e.stopImmediatePropagation();
          intercepted = true;
        }
        await handlePdf(item.getAsFile());
      }
    }
  }, { capture: true }); // Intercept early before Claude handles paste

  // File input (upload button)
  function patchFileInput(input) {
    if (input.__mpdfPatched) return;
    input.__mpdfPatched = true;
    input.addEventListener("change", async (e) => {
      if (isInjectingFile) return; // Skip during our own .md injection
      const files = Array.from(e.target.files || []);
      const pdfFiles = files.filter(f => f.type === "application/pdf");
      if (pdfFiles.length === 0) return;

      // Prevent synchronously before any async work
      e.preventDefault();
      e.stopImmediatePropagation();
      input.value = ""; // Clear file input so Claude doesn't read it

      for (const file of pdfFiles) {
        await handlePdf(file);
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
    if (isInjectingFile) return; // Skip during our own .md injection
    const files = Array.from(e.dataTransfer?.files || []);
    const pdfFiles = files.filter(f => f.type === "application/pdf");
    if (pdfFiles.length === 0) return;

    // Prevent synchronously before any async work
    e.preventDefault();
    e.stopImmediatePropagation();

    for (const file of pdfFiles) {
      await handlePdf(file);
    }
  }, { capture: true });

  // Prevent default dragover to allow drop
  document.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault(); // Required to allow custom drop handling
    }
  }, { capture: true });

  // ─── Helpers ─────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function fmtBytes(b) {
    if (b < 1024) return b + " B";
    if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
    return (b / 1048576).toFixed(1) + " MB";
  }

  console.log("[MarkPDF] Loaded on", location.hostname);
})();
