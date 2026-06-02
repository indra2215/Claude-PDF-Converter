/**
 * ISR-CONVERTER - Universal Document Converter for Claude
 * Created by Indra
 * Version 2.1.0 - Smart OCR with Quality Control
 * 
 * Runs on claude.ai. Intercepts various file uploads and converts to Markdown.
 *
 * Supported formats:
 *   - PDF (text-based and scanned with smart OCR)
 *   - Word documents (.docx)
 *   - Images (JPEG, PNG, GIF, WebP - with OCR quality control)
 *   - CSV, JSON, XML (structured data)
 *   - HTML (clean content extraction)
 *
 * Smart Features:
 *   - Quality scoring (0-100% confidence)
 *   - Auto-skip low quality files (<50%)
 *   - Batch conversion prompts
 *   - User control over conversions
 *
 * Pipeline:
 *   1. Detect file type from MIME type
 *   2. Analyze quality/confidence
 *   3. Route to appropriate converter
 *   4. Convert to clean Markdown
 *   5. Inject as .md file into Claude's chat
 */

(function () {
  "use strict";

  // ─── SPA Re-injection Guard ───────────────────────────────────────────────────
  // Claude.ai is a SPA; on navigation the content script may be re-injected,
  // which would add duplicate event listeners. This guard prevents that.
  if (window.__mpdfLoaded) return;
  window.__mpdfLoaded = true;

  // ─── Supported file types ─────────────────────────────────────────────────────
  const SUPPORTED_TYPES = {
    pdf: ['application/pdf'],
    image: ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/tiff'],
    csv: ['text/csv', 'application/vnd.ms-excel'],
    json: ['application/json', 'text/json'],
    xml: ['application/xml', 'text/xml'],
    html: ['text/html', 'application/xhtml+xml'],
    docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  };

  const ALL_SUPPORTED_TYPES = Object.values(SUPPORTED_TYPES).flat();

  // ─── Sanity checks ────────────────────────────────────────────────────────────
  if (typeof pdfjsLib === "undefined") {
    console.error("[ISR-CONVERTER] pdf.js not loaded. Extension may be broken.");
    return;
  }

  if (typeof mammoth === "undefined") {
    console.warn("[ISR-CONVERTER] mammoth.js not loaded. Word document conversion unavailable.");
  }

  console.log("[ISR-CONVERTER] Loaded successfully. Version 2.1.0");
  console.log("[ISR-CONVERTER] Supported types:", Object.keys(SUPPORTED_TYPES).join(", "));

  // Set PDF.js worker source (Manifest V3 compatible)
  // Try extension URL first, with fallback to inline worker
  try {
    const pdfWorkerUrl = chrome.runtime.getURL("lib/pdf.worker.min.js");
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    console.log("[ISR-CONVERTER] PDF worker URL set:", pdfWorkerUrl);
  } catch (err) {
    console.warn("[ISR-CONVERTER] Could not set worker URL:", err);
    // Fallback: disable worker (will use main thread, slower but works)
    pdfjsLib.GlobalWorkerOptions.workerSrc = null;
  }

  // ─── Constants ────────────────────────────────────────────────────────────────
  const MIN_CHARS_PER_PAGE = 30; // below this → treat page as image-based (lowered from 80 to avoid unnecessary OCR on sparse-but-valid pages like chapter titles)
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
        console.log("[ISR-CONVERTER] Tesseract worker terminated (idle timeout)");
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

      // Tightened thresholds to avoid promoting normal sentences to headings
      if (wc <= 8 && noEndPunct) {
        if (isAllCaps && wc <= 4) return `## ${t}`;
        if (titleRatio > 0.8 && wc <= 5) return `### ${t}`;
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
    try {
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
  } catch (err) {
    console.error("[ISR-CONVERTER] PDF conversion error:", err);
    throw new Error(`PDF processing failed: ${err.message}`);
  }
}

  // ─── Image Conversion (EXIF + OCR) ────────────────────────────────────────────
  async function convertImageToMarkdown(arrayBuffer, fileName) {
    const blob = new Blob([arrayBuffer]);
    const dataUrl = await blobToDataUrl(blob);
    
    // Extract EXIF metadata
    const exifData = await extractExif(arrayBuffer);
    
    // Perform OCR with better configuration
    const worker = await getTesseractWorker();
    
    // Configure Tesseract for better accuracy
    const { data: { text, confidence } } = await worker.recognize(dataUrl, {
      rotateAuto: true,  // Auto-rotate based on script detection
    });
    
    scheduleWorkerCleanup();
    
    const baseName = fileName.replace(/\.[^.]+$/, "");
    let markdown = `# ${baseName}\n\n`;
    
    // Add quality recommendation
    const fileSize = arrayBuffer.byteLength;
    const shouldRecommendOriginal = confidence < 70 || text.trim().length < 50;
    
    if (shouldRecommendOriginal) {
      markdown += `> 💡 **Recommendation:** OCR confidence is low (${Math.round(confidence)}%). For better results, consider uploading the original image directly to Claude - it has more advanced vision capabilities.\n\n`;
    }
    
    // Add EXIF metadata if available
    if (exifData && Object.keys(exifData).length > 0) {
      markdown += `## Image Metadata\n\n`;
      for (const [key, value] of Object.entries(exifData)) {
        markdown += `- **${key}**: ${value}\n`;
      }
      markdown += `\n`;
    }
    
    // Add OCR text if found
    const cleanedText = text ? text.trim() : '';
    const hasText = cleanedText.length > 0;
    
    if (hasText) {
      markdown += `## Extracted Text\n\n`;
      
      // Add confidence warning if low
      if (confidence < 70) {
        markdown += `> ⚠️ **Low OCR confidence (${Math.round(confidence)}%)** - Text may be inaccurate. Please verify against original.\n\n`;
      }
      
      // Clean up OCR artifacts
      const lines = cleanedText
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
      
      markdown += lines.join('\n\n') + '\n';
    } else {
      markdown += `## ⚠️ No Text Detected\n\n`;
      markdown += `This could mean:\n`;
      markdown += `- Image contains no text\n`;
      markdown += `- Text is too small or blurry (try higher resolution)\n`;
      markdown += `- Handwritten text (not supported by OCR)\n`;
      markdown += `- Complex background or low contrast\n\n`;
      markdown += `**💡 Tip:** Upload the original image directly to Claude for better vision analysis.\n`;
    }
    
    return {
      markdown,
      stats: {
        hasMetadata: exifData && Object.keys(exifData).length > 0,
        hasText: hasText,
        textLength: cleanedText.length,
        confidence: Math.round(confidence || 0),
        recommendOriginal: shouldRecommendOriginal,
      },
    };
  }

  // ─── CSV Conversion ───────────────────────────────────────────────────────────
  function convertCsvToMarkdown(text, fileName) {
    const baseName = fileName.replace(/\.[^.]+$/, "");
    const lines = text.trim().split(/\r?\n/);
    
    if (lines.length === 0) {
      return {
        markdown: `# ${baseName}\n\n*Empty CSV file*`,
        stats: { rows: 0, columns: 0 },
      };
    }
    
    // Parse CSV (simple parser - handles quoted fields)
    const rows = lines.map(line => {
      const cells = [];
      let current = '';
      let inQuotes = false;
      
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        const next = line[i + 1];
        
        if (char === '"' && inQuotes && next === '"') {
          current += '"';
          i++; // skip next quote
        } else if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          cells.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      cells.push(current.trim());
      return cells;
    });
    
    const maxCols = Math.max(...rows.map(r => r.length));
    
    // Build Markdown table - LIMIT to prevent Claude slowdown
    let markdown = `# ${baseName}\n\n`;
    
    // Add info for large files (but don't limit rows)
    if (rows.length > 100) {
      markdown += `> 📊 **Large dataset**: ${rows.length} rows, ${maxCols} columns\n`;
      markdown += `> Claude may take a moment to process this data.\n\n`;
    }
    
    if (rows.length > 0) {
      // Header row
      markdown += '| ' + rows[0].map(cell => esc(cell || '')).join(' | ') + ' |\n';
      markdown += '| ' + Array(rows[0].length).fill('---').join(' | ') + ' |\n';
      
      // Data rows (show ALL rows - no limit)
      for (let i = 1; i < rows.length; i++) {
        markdown += '| ' + rows[i].map(cell => esc(cell || '')).join(' | ') + ' |\n';
      }
    }
    
    return {
      markdown,
      stats: {
        rows: rows.length,
        columns: maxCols,
      },
    };
  }

  // ─── JSON Conversion ──────────────────────────────────────────────────────────
  function convertJsonToMarkdown(text, fileName) {
    const baseName = fileName.replace(/\.[^.]+$/, "");
    
    try {
      const data = JSON.parse(text);
      let markdown = `# ${baseName}\n\n`;
      
      markdown += '```json\n' + JSON.stringify(data, null, 2) + '\n```\n\n';
      
      // If it's an array of objects, create a table
      if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object') {
        markdown += `## Data Table\n\n`;
        const keys = Object.keys(data[0]);
        
        // Header
        markdown += '| ' + keys.map(k => esc(k)).join(' | ') + ' |\n';
        markdown += '| ' + keys.map(() => '---').join(' | ') + ' |\n';
        
        // Rows (limit to first 100)
        for (let i = 0; i < Math.min(data.length, 100); i++) {
          const row = data[i];
          markdown += '| ' + keys.map(k => {
            const val = row[k];
            return esc(val !== undefined && val !== null ? String(val) : '');
          }).join(' | ') + ' |\n';
        }
        
        if (data.length > 100) {
          markdown += `\n*Showing first 100 of ${data.length} rows*\n`;
        }
      }
      
      return {
        markdown,
        stats: {
          type: Array.isArray(data) ? 'array' : 'object',
          length: Array.isArray(data) ? data.length : Object.keys(data).length,
        },
      };
    } catch (err) {
      return {
        markdown: `# ${baseName}\n\n\`\`\`json\n${text}\n\`\`\`\n\n*Failed to parse JSON: ${err.message}*`,
        stats: { error: err.message },
      };
    }
  }

  // ─── XML Conversion ───────────────────────────────────────────────────────────
  function convertXmlToMarkdown(text, fileName) {
    const baseName = fileName.replace(/\.[^.]+$/, "");
    
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, 'application/xml');
      
      // Check for parse errors
      const parseError = doc.querySelector('parsererror');
      if (parseError) {
        throw new Error('Invalid XML structure');
      }
      
      let markdown = `# ${baseName}\n\n`;
      
      // Show formatted XML
      markdown += '```xml\n' + text.trim() + '\n```\n\n';
      
      // Extract text content in a structured way
      markdown += `## Extracted Content\n\n`;
      markdown += xmlNodeToMarkdown(doc.documentElement, 0);
      
      return {
        markdown,
        stats: {
          rootElement: doc.documentElement.tagName,
          nodeCount: doc.getElementsByTagName('*').length,
        },
      };
    } catch (err) {
      return {
        markdown: `# ${baseName}\n\n\`\`\`xml\n${text}\n\`\`\`\n\n*Failed to parse XML: ${err.message}*`,
        stats: { error: err.message },
      };
    }
  }

  function xmlNodeToMarkdown(node, depth) {
    if (!node || node.nodeType !== 1) return '';
    
    const indent = '  '.repeat(depth);
    let md = '';
    
    // Node name as heading or list item
    if (depth === 0) {
      md += `### ${node.tagName}\n\n`;
    } else {
      md += `${indent}- **${node.tagName}**`;
    }
    
    // Attributes
    if (node.attributes && node.attributes.length > 0) {
      const attrs = Array.from(node.attributes)
        .map(attr => `${attr.name}="${attr.value}"`)
        .join(', ');
      md += ` (${attrs})`;
    }
    
    // Text content (if no child elements)
    const childElements = Array.from(node.children);
    if (childElements.length === 0 && node.textContent.trim()) {
      md += `: ${node.textContent.trim()}\n`;
    } else {
      md += '\n';
      // Process child elements
      for (const child of childElements) {
        md += xmlNodeToMarkdown(child, depth + 1);
      }
    }
    
    return md;
  }

  // ─── HTML Conversion ──────────────────────────────────────────────────────────
  function convertHtmlToMarkdown(text, fileName) {
    const baseName = fileName.replace(/\.[^.]+$/, "");
    
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/html');
    
    // Remove script, style, nav, footer elements
    doc.querySelectorAll('script, style, nav, footer, header, aside').forEach(el => el.remove());
    
    let markdown = `# ${baseName}\n\n`;
    
    // Extract title
    const title = doc.querySelector('title');
    if (title && title.textContent.trim()) {
      markdown = `# ${title.textContent.trim()}\n\n`;
    }
    
    // Convert main content area (look for main, article, or body)
    const mainContent = doc.querySelector('main, article, [role="main"]') || doc.body;
    
    if (mainContent) {
      markdown += htmlToMarkdown(mainContent);
    }
    
    return {
      markdown: markdown.replace(/\n{3,}/g, '\n\n').trim(),
      stats: {
        title: title?.textContent.trim() || baseName,
      },
    };
  }

  function htmlToMarkdown(element) {
    let md = '';
    
    for (const node of element.childNodes) {
      if (node.nodeType === 3) { // Text node
        const text = node.textContent.trim();
        if (text) md += text + ' ';
      } else if (node.nodeType === 1) { // Element node
        const tag = node.tagName.toLowerCase();
        
        switch (tag) {
          case 'h1':
            md += `\n\n# ${node.textContent.trim()}\n\n`;
            break;
          case 'h2':
            md += `\n\n## ${node.textContent.trim()}\n\n`;
            break;
          case 'h3':
            md += `\n\n### ${node.textContent.trim()}\n\n`;
            break;
          case 'h4':
            md += `\n\n#### ${node.textContent.trim()}\n\n`;
            break;
          case 'h5':
            md += `\n\n##### ${node.textContent.trim()}\n\n`;
            break;
          case 'h6':
            md += `\n\n###### ${node.textContent.trim()}\n\n`;
            break;
          case 'p':
            md += `\n\n${htmlToMarkdown(node).trim()}\n\n`;
            break;
          case 'br':
            md += '\n';
            break;
          case 'strong':
          case 'b':
            md += `**${node.textContent.trim()}**`;
            break;
          case 'em':
          case 'i':
            md += `*${node.textContent.trim()}*`;
            break;
          case 'code':
            md += `\`${node.textContent.trim()}\``;
            break;
          case 'pre':
            md += `\n\n\`\`\`\n${node.textContent.trim()}\n\`\`\`\n\n`;
            break;
          case 'a':
            const href = node.getAttribute('href');
            md += `[${node.textContent.trim()}](${href || '#'})`;
            break;
          case 'ul':
          case 'ol':
            md += '\n' + htmlListToMarkdown(node, tag === 'ol') + '\n';
            break;
          case 'li':
            // Handled by parent ul/ol
            break;
          case 'blockquote':
            const lines = htmlToMarkdown(node).trim().split('\n');
            md += '\n\n' + lines.map(l => `> ${l}`).join('\n') + '\n\n';
            break;
          case 'table':
            md += '\n\n' + htmlTableToMarkdown(node) + '\n\n';
            break;
          default:
            md += htmlToMarkdown(node);
        }
      }
    }
    
    return md;
  }

  function htmlListToMarkdown(listElement, isOrdered) {
    let md = '';
    const items = listElement.querySelectorAll(':scope > li');
    
    items.forEach((li, idx) => {
      const prefix = isOrdered ? `${idx + 1}. ` : '- ';
      md += prefix + htmlToMarkdown(li).trim() + '\n';
    });
    
    return md;
  }

  function htmlTableToMarkdown(table) {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (rows.length === 0) return '';
    
    let md = '';
    
    rows.forEach((row, rowIdx) => {
      const cells = Array.from(row.querySelectorAll('th, td'));
      md += '| ' + cells.map(cell => cell.textContent.trim()).join(' | ') + ' |\n';
      
      // Add separator after header row
      if (rowIdx === 0) {
        md += '| ' + cells.map(() => '---').join(' | ') + ' |\n';
      }
    });
    
    return md;
  }

  // ─── Word Document Conversion (.docx) ─────────────────────────────────────────
  async function convertDocxToMarkdown(arrayBuffer, fileName) {
    try {
      // Check if mammoth is loaded
      if (typeof mammoth === "undefined") {
        throw new Error("mammoth.js library not loaded");
      }

      const result = await mammoth.convertToMarkdown({arrayBuffer: arrayBuffer});
      
      const baseName = fileName.replace(/\.docx$/i, "");
      let markdown = `# ${baseName}\n\n`;
      markdown += result.value;
      
      // Add conversion warnings if any
      if (result.messages && result.messages.length > 0) {
        const warnings = result.messages.filter(m => m.type === 'warning' || m.type === 'error');
        if (warnings.length > 0) {
          markdown += `\n\n> ⚠️ **Conversion Notes:**\n`;
          warnings.forEach(msg => {
            markdown += `> - ${msg.message}\n`;
          });
        }
      }
      
      return {
        markdown,
        stats: {
          hasWarnings: result.messages && result.messages.filter(m => m.type === 'warning' || m.type === 'error').length > 0,
          warningCount: result.messages ? result.messages.filter(m => m.type === 'warning' || m.type === 'error').length : 0,
        },
      };
    } catch (err) {
      console.error("[ISR-CONVERTER] Word document conversion error:", err);
      throw new Error(`Word document processing failed: ${err.message}`);
    }
  }

  // ─── EXIF metadata extraction ─────────────────────────────────────────────────
  async function extractExif(arrayBuffer) {
    // Simple EXIF parser for JPEG files
    const view = new DataView(arrayBuffer);
    
    // Check for JPEG signature
    if (view.getUint16(0) !== 0xFFD8) {
      return null; // Not a JPEG
    }
    
    const exifData = {};
    
    try {
      // Look for APP1 marker (EXIF)
      let offset = 2;
      while (offset < view.byteLength) {
        const marker = view.getUint16(offset);
        
        if (marker === 0xFFE1) { // APP1 (EXIF)
          const size = view.getUint16(offset + 2);
          
          // Check for EXIF identifier
          const exifId = String.fromCharCode(
            view.getUint8(offset + 4),
            view.getUint8(offset + 5),
            view.getUint8(offset + 6),
            view.getUint8(offset + 7)
          );
          
          if (exifId === 'Exif') {
            // Basic metadata extraction (simplified)
            exifData['Format'] = 'JPEG';
            exifData['Has EXIF'] = 'Yes';
            // Full EXIF parsing would require a library, but this gives us basic info
          }
          break;
        }
        
        offset += 2 + view.getUint16(offset + 2);
      }
    } catch (err) {
      console.log('[Converter] EXIF extraction failed:', err);
    }
    
    // Get basic file info
    exifData['File Size'] = fmtBytes(arrayBuffer.byteLength);
    
    return exifData;
  }

  // ─── Helper: Blob to DataURL ──────────────────────────────────────────────────
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
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
    const mdFileName = fileName.replace(/\.(pdf|csv|json|xml|html|jpg|jpeg|png|gif|webp|bmp|tiff)$/i, ".md");
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
        // Bug fix: use try/finally so isInjectingFile is always reset,
        // even if dispatchEvent throws unexpectedly
        isInjectingFile = true;
        try {
          input.files = dt.files;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          injected = true;
        } finally {
          isInjectingFile = false;
        }
        break; // Bug fix: stop after first successful injection — prevents duplicate uploads to multiple file inputs
      } catch (err) {
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
      const originalName = fileName.replace(/\.(pdf|csv|json|xml|html|jpg|jpeg|png|gif|webp|bmp|tiff)$/i, "");
      const label = `*[Converted from: ${originalName}]*\n\n`;
      const fullText = label + mdText;
      // Use Selection API (document.execCommand is deprecated in modern browsers)
      let inserted = false;
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        try {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          range.insertNode(document.createTextNode(fullText));
          range.collapse(false);
          editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
          inserted = true;
        } catch (_) { /* fall through to innerText fallback */ }
      }
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
        try {
          input.files = dt.files;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          injected = true;
        } finally {
          isInjectingFile = false;
        }
        break; // Bug fix: stop after first successful injection — prevents duplicate uploads
      } catch (err) {
        continue;
      }
    }

    if (injected) {
      showSimpleToast(`\u2705 Original PDF attached: ${esc(file.name)}`);
      return;
    }

    showSimpleToast("\u26A0 Could not attach raw PDF");
  }

  // ─── File type detection ──────────────────────────────────────────────────────
  function getFileType(mimeType) {
    for (const [type, mimes] of Object.entries(SUPPORTED_TYPES)) {
      if (mimes.includes(mimeType)) return type;
    }
    return null;
  }

  function getFileIcon(fileType) {
    const icons = {
      pdf: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14,2 14,8 20,8"/>
      </svg>`,
      docx: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14,2 14,8 20,8"/>
        <line x1="8" y1="13" x2="16" y2="13"/>
        <line x1="8" y1="16" x2="16" y2="16"/>
        <line x1="8" y1="19" x2="13" y2="19"/>
      </svg>`,
      image: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
        <circle cx="8.5" cy="8.5" r="1.5"/>
        <polyline points="21,15 16,10 5,21"/>
      </svg>`,
      csv: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14,2 14,8 20,8"/>
        <line x1="8" y1="13" x2="16" y2="13"/>
        <line x1="8" y1="17" x2="16" y2="17"/>
      </svg>`,
      json: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14,2 14,8 20,8"/>
        <path d="M10 12h4M10 16h4"/>
      </svg>`,
      xml: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14,2 14,8 20,8"/>
        <path d="M9 17l3-5-3-5M15 12l3 5M15 12l3-5"/>
      </svg>`,
      html: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
        <polyline points="16,18 22,12 16,6"/>
        <polyline points="8,6 2,12 8,18"/>
      </svg>`,
    };
    return icons[fileType] || icons.pdf;
  }

  function getFileTypeLabel(fileType) {
    const labels = {
      pdf: 'PDF',
      docx: 'Word',
      image: 'Image',
      csv: 'CSV',
      json: 'JSON',
      xml: 'XML',
      html: 'HTML',
    };
    return labels[fileType] || 'File';
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

  function showDetectedToast(fileName, size, fileType, onConvert) {
    const queueInfo = pdfQueue.length > 1 ? ` · File 1 of ${pdfQueue.length}` : "";
    const typeLabel = getFileTypeLabel(fileType);
    const icon = getFileIcon(fileType);
    
    const toast = makeToast(`
      <div class="mpdf-icon mpdf-icon-pdf">
        ${icon}
      </div>
      <div class="mpdf-body">
        <div class="mpdf-title">${esc(fileName)}</div>
        <div class="mpdf-sub">${fmtBytes(size)}${queueInfo} · ${typeLabel} detected</div>
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

  function showDoneToast(fileName, stats, mdText, fileType) {
    const mdTokens = Math.round(mdText.length / 4);
    
    let statsInfo = '';
    
    if (fileType === 'pdf') {
      const pdfTokensEstimate = stats.totalPages * 1500;
      const tokensSaved = Math.max(0, pdfTokensEstimate - mdTokens);
      statsInfo = `${stats.totalPages}p · ~${mdTokens.toLocaleString()} tokens (Saved ~${tokensSaved.toLocaleString()})`;
      
      if (stats.ocrPages > 0) {
        statsInfo += ` <span class="mpdf-badge mpdf-badge-warn">OCR: ${stats.ocrPages}p</span>`;
      }
      if (stats.hasLowConfidence) {
        statsInfo += ` <span class="mpdf-badge mpdf-badge-danger">Low confidence</span>`;
      }
    } else if (fileType === 'image') {
      statsInfo = `~${mdTokens.toLocaleString()} tokens`;
      if (stats.hasText) {
        const confBadge = stats.confidence >= 80 
          ? '<span class="mpdf-badge mpdf-badge-done">High confidence</span>'
          : stats.confidence >= 60
          ? '<span class="mpdf-badge mpdf-badge-warn">Medium confidence</span>'
          : '<span class="mpdf-badge mpdf-badge-danger">Low confidence</span>';
        statsInfo += ` · Text: ${stats.textLength} chars · ${confBadge}`;
      } else {
        statsInfo += ` · No text detected`;
      }
      if (stats.hasMetadata) {
        statsInfo += ` · Has metadata`;
      }
    } else if (fileType === 'csv') {
      statsInfo = `${stats.rows} rows × ${stats.columns} cols · ~${mdTokens.toLocaleString()} tokens`;
    } else if (fileType === 'json') {
      statsInfo = `${stats.type} · ${stats.length} items · ~${mdTokens.toLocaleString()} tokens`;
    } else if (fileType === 'xml') {
      statsInfo = `${stats.nodeCount} nodes · ~${mdTokens.toLocaleString()} tokens`;
    } else if (fileType === 'html') {
      statsInfo = `~${mdTokens.toLocaleString()} tokens`;
    }

    const toast = makeToast(`
      <div class="mpdf-icon mpdf-icon-done">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="20,6 9,17 4,12"/>
        </svg>
      </div>
      <div class="mpdf-body">
        <div class="mpdf-title">${esc(fileName.replace(/\.[^.]+$/i, ".md"))}</div>
        <div class="mpdf-sub">${statsInfo}</div>
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
    `, 0); // Bug fix: pass 0 — let handleClose own all close logic (avoids duplicate timer that skips onClose callback)
    
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
    const { name: fileName, size, type: mimeType } = file;
    const fileType = getFileType(mimeType);

    if (!fileType) {
      console.error('[Converter] Unsupported file type:', mimeType);
      pdfQueue.shift();
      processNextInQueue();
      return;
    }

    showDetectedToast(fileName, size, fileType, async () => {
      const typeLabel = getFileTypeLabel(fileType);
      showProcessingToast(fileName, `Reading ${typeLabel} structure…`);

      try {
        const buffer = await file.arrayBuffer();
        let result;

        // Route to appropriate converter
        switch (fileType) {
          case 'pdf':
            result = await convertPdfToMarkdown(
              buffer,
              fileName,
              ({ stage, page, total }) => {
                const label = document.getElementById("mpdf-progress-label");
                if (!label) return;
                if (stage === "extracting") {
                  label.textContent = `Extracting text… page ${page}/${total}`;
                } else if (stage === "ocr") {
                  label.textContent = `OCR page ${page}/${total} (image-based)…`;
                }
              }
            );
            break;

          case 'image':
            result = await convertImageToMarkdown(buffer, fileName);
            break;

          case 'csv':
            const csvText = new TextDecoder('utf-8').decode(buffer);
            result = convertCsvToMarkdown(csvText, fileName);
            break;

          case 'json':
            const jsonText = new TextDecoder('utf-8').decode(buffer);
            result = convertJsonToMarkdown(jsonText, fileName);
            break;

          case 'xml':
            const xmlText = new TextDecoder('utf-8').decode(buffer);
            result = convertXmlToMarkdown(xmlText, fileName);
            break;

          case 'html':
            const htmlText = new TextDecoder('utf-8').decode(buffer);
            result = convertHtmlToMarkdown(htmlText, fileName);
            break;

          case 'docx':
            result = await convertDocxToMarkdown(buffer, fileName);
            break;

          default:
            throw new Error(`Unsupported file type: ${fileType}`);
        }

        showDoneToast(fileName, result.stats, result.markdown, fileType);
      } catch (err) {
        console.error("[Converter]", err);
        const msg = err.message?.includes("password")
          ? "File is password-protected — cannot extract"
          : err.message?.includes("Invalid")
          ? "File does not appear to be valid"
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
      const fileType = getFileType(file.type);
      const typeLabel = getFileTypeLabel(fileType);
      const queueInfo = pdfQueue.length > 1 ? ` · File 1 of ${pdfQueue.length}` : "";
      subEl.innerHTML = `${fmtBytes(file.size)}${queueInfo} · ${typeLabel} detected`;
    }
  }

  function handleFile(file) {
    if (!file) return false;
    
    const fileType = getFileType(file.type);
    if (!fileType) return false;
    
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
  document.addEventListener("paste", (e) => {
    let intercepted = false;
    for (const item of Array.from(e.clipboardData?.items || [])) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file && ALL_SUPPORTED_TYPES.includes(file.type)) {
          if (!intercepted) {
            e.preventDefault();
            e.stopImmediatePropagation();
            intercepted = true;
          }
          handleFile(file);
        }
      }
    }
  }, { capture: true }); // Intercept early before Claude handles paste

  // File input (upload button)
  function patchFileInput(input) {
    if (input.__mpdfPatched) return;
    input.__mpdfPatched = true;
    input.addEventListener("change", (e) => {
      if (isInjectingFile) return; // Skip during our own .md injection
      const files = Array.from(e.target.files || []);
      const supportedFiles = files.filter(f => ALL_SUPPORTED_TYPES.includes(f.type));
      if (supportedFiles.length === 0) return;

      // Prevent synchronously before any async work
      e.preventDefault();
      e.stopImmediatePropagation();
      input.value = ""; // Clear file input so Claude doesn't read it

      for (const file of supportedFiles) {
        handleFile(file);
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
  document.addEventListener("drop", (e) => {
    if (isInjectingFile) return; // Skip during our own .md injection
    const files = Array.from(e.dataTransfer?.files || []);
    const supportedFiles = files.filter(f => ALL_SUPPORTED_TYPES.includes(f.type));
    if (supportedFiles.length === 0) return;

    // Prevent synchronously before any async work
    e.preventDefault();
    e.stopImmediatePropagation();

    for (const file of supportedFiles) {
      handleFile(file);
    }
  }, { capture: true });

  // Prevent default dragover to allow drop
  document.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault(); // Required to allow custom drop handling
    }
  }, { capture: true });

  // Bug fix: reposition active toast whenever the window resizes
  // (Claude's composer area can shift position on resize/layout changes)
  window.addEventListener("resize", () => {
    if (activeToast) positionToastAboveInput(activeToast);
  });

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

  console.log("[ISR-CONVERTER] Loaded on", location.hostname);
  console.log("[ISR-CONVERTER] Supported types:", Object.keys(SUPPORTED_TYPES).join(', '));
})();
