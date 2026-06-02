# ISR-CONVERTER - Testing Guide v2.0.0

**Created by Indra**

## Phase 1 Features Testing Checklist

### Setup
1. Load the extension in Chrome/Edge/Brave:
   - Navigate to `chrome://extensions/` (or `edge://extensions/`)
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the `Claude-PDF-Converter` folder
2. Open [claude.ai](https://claude.ai) and start a new chat

### Test Files
Sample test files are provided in the `test-samples/` directory:
- `sample.csv` - Simple CSV with user data
- `sample.json` - JSON with nested structure
- `sample.xml` - XML bookstore catalog
- `sample.html` - HTML article with various elements

---

## 📄 PDF Testing (Existing Feature)

### Test 1: Text-based PDF
- [ ] Upload/paste a text-based PDF
- [ ] Verify toast shows "PDF detected"
- [ ] Click "Convert to .md"
- [ ] Verify conversion completes quickly (<2 seconds)
- [ ] Click "Attach .md to Claude"
- [ ] Verify .md file appears in chat attachments
- [ ] Expected: Clean markdown with headings, paragraphs preserved

### Test 2: Scanned/Image PDF
- [ ] Upload a scanned PDF or image-based PDF
- [ ] Verify OCR progress indicator appears
- [ ] Verify warning badge shows "OCR: Xp"
- [ ] Verify converted text is reasonably accurate
- [ ] Expected: OCR may be slower (5-10 seconds per page)

---

## 🖼️ Image Testing (NEW)

### Test 3: JPEG/PNG with Text
- [ ] Upload `sample.jpg` or screenshot with text
- [ ] Verify toast shows "Image detected"
- [ ] Click "Convert to .md"
- [ ] Verify EXIF metadata section appears (if available)
- [ ] Verify OCR extracts visible text
- [ ] Expected: Markdown with metadata + extracted text

### Test 4: Multiple Image Formats
- [ ] Test with: PNG, GIF, WebP
- [ ] Verify all formats are detected and processed
- [ ] Expected: Consistent behavior across formats

---

## 📊 CSV Testing (NEW)

### Test 5: Simple CSV
- [ ] Upload/paste `test-samples/sample.csv`
- [ ] Verify toast shows "CSV detected"
- [ ] Click "Convert to .md"
- [ ] Verify instant conversion (<100ms)
- [ ] Verify Markdown table is created
- [ ] Verify header row is bold/separated
- [ ] Verify all rows and columns preserved
- [ ] Expected output:
```markdown
# sample

| Name | Age | City | Occupation |
| --- | --- | --- | --- |
| John Doe | 32 | New York | Software Engineer |
...
```

### Test 6: CSV with Special Characters
- [ ] Test CSV with commas in quoted fields: `"Doe, John"`
- [ ] Test CSV with quotes: `"He said ""hello"""`
- [ ] Verify proper escaping in output

---

## { } JSON Testing (NEW)

### Test 7: Simple JSON Object
- [ ] Upload/paste `test-samples/sample.json`
- [ ] Verify toast shows "JSON detected"
- [ ] Click "Convert to .md"
- [ ] Verify formatted code block appears
- [ ] Expected: Properly indented JSON with syntax

### Test 8: JSON Array of Objects
- [ ] Test JSON with array of objects (like users list)
- [ ] Verify auto-table generation works
- [ ] Verify both code block AND table are shown
- [ ] Expected: Table with columns for each object key

### Test 9: Invalid JSON
- [ ] Upload malformed JSON: `{invalid: json}`
- [ ] Verify error message appears in markdown
- [ ] Verify raw content is still shown in code block

---

## 📋 XML Testing (NEW)

### Test 10: Well-formed XML
- [ ] Upload/paste `test-samples/sample.xml`
- [ ] Verify toast shows "XML detected"
- [ ] Click "Convert to .md"
- [ ] Verify structured content extraction
- [ ] Verify nested elements are indented
- [ ] Verify attributes are shown in parentheses
- [ ] Expected: Hierarchical list format

### Test 11: Invalid XML
- [ ] Test malformed XML: `<unclosed><tag>`
- [ ] Verify error message appears
- [ ] Verify raw XML is still shown

---

## 🌐 HTML Testing (NEW)

### Test 12: Clean HTML Article
- [ ] Upload/paste `test-samples/sample.html`
- [ ] Verify toast shows "HTML detected"
- [ ] Click "Convert to .md"
- [ ] Verify clean extraction (no nav, footer, scripts)
- [ ] Verify headings preserved (h1 → #, h2 → ##)
- [ ] Verify lists preserved with bullets/numbers
- [ ] Verify links preserved `[text](url)`
- [ ] Verify tables converted to Markdown tables
- [ ] Verify blockquotes have `>` prefix
- [ ] Verify bold/italic formatting preserved

### Test 13: Complex HTML
- [ ] Test HTML with nested structures
- [ ] Verify reasonable output even if imperfect

---

## 🧪 Multi-File Queue Testing

### Test 14: Mixed File Types
- [ ] Drop 5 files at once: PDF, CSV, JSON, XML, HTML
- [ ] Verify queue counter shows "File 1 of 5"
- [ ] Process first file
- [ ] Verify queue advances to "File 2 of 5"
- [ ] Verify all files process in order (FIFO)

### Test 15: Queue with Skip
- [ ] Drop 3 files
- [ ] Click "✕" (skip) on first file
- [ ] Verify original file is attached to Claude (not converted)
- [ ] Verify queue advances to next file

---

## 🎨 UI/UX Testing

### Test 16: Toast Positioning
- [ ] Verify toast appears above chat input area
- [ ] Resize window, verify toast repositions correctly
- [ ] Verify toast doesn't block input area

### Test 17: File Type Icons
- [ ] Verify each file type shows correct icon:
  - PDF: Document icon
  - Image: Picture icon
  - CSV: Table icon
  - JSON: Curly braces icon
  - XML: Code icon
  - HTML: HTML brackets icon

### Test 18: Statistics Display
- [ ] PDF: Shows "Xp · Y tokens (Saved Z)"
- [ ] Image: Shows "~X tokens · Text extracted"
- [ ] CSV: Shows "X rows × Y cols · ~Z tokens"
- [ ] JSON: Shows "array · X items · ~Y tokens"
- [ ] XML: Shows "X nodes · ~Y tokens"
- [ ] HTML: Shows "~X tokens"

---

## 🔄 Integration Testing

### Test 19: Paste (Ctrl+V)
- [ ] Copy a CSV file
- [ ] Press Ctrl+V in Claude chat
- [ ] Verify extension intercepts paste
- [ ] Verify conversion flow works

### Test 20: Drag & Drop
- [ ] Drag multiple files from desktop
- [ ] Drop on Claude chat area
- [ ] Verify all files are queued
- [ ] Verify conversion works

### Test 21: File Upload Button
- [ ] Click Claude's file upload button
- [ ] Select a JSON file
- [ ] Verify extension intercepts upload
- [ ] Verify conversion works

---

## 🐛 Error Handling Testing

### Test 22: Unsupported File Type
- [ ] Try uploading .docx or .zip
- [ ] Verify extension ignores it (Claude handles normally)
- [ ] No error toast should appear

### Test 23: Corrupted Files
- [ ] Upload corrupted PDF
- [ ] Verify error toast appears
- [ ] Verify clear error message

### Test 24: Empty Files
- [ ] Upload empty CSV, JSON, XML
- [ ] Verify graceful handling (no crash)
- [ ] Verify appropriate message in output

---

## ♿ Accessibility Testing

### Test 25: Screen Reader
- [ ] Enable screen reader
- [ ] Trigger conversion
- [ ] Verify ARIA alerts are announced
- [ ] Verify toast roles are correct

### Test 26: Keyboard Navigation
- [ ] Tab through toast buttons
- [ ] Verify focus indicators visible
- [ ] Verify Enter/Space activate buttons

---

## 🔒 Privacy Testing

### Test 27: Network Activity
- [ ] Open browser DevTools → Network tab
- [ ] Convert various files (except OCR)
- [ ] Verify NO network requests (except Tesseract model on first OCR)
- [ ] Verify all processing is local

---

## 📊 Performance Testing

### Test 28: Large Files
- [ ] 10 MB CSV file
- [ ] 100-page PDF
- [ ] 1 MB JSON file
- [ ] Verify no crashes
- [ ] Verify reasonable processing time

### Test 29: Memory Usage
- [ ] Open Task Manager → Chrome memory
- [ ] Convert 10 files in a row
- [ ] Verify memory doesn't grow excessively
- [ ] Verify OCR worker terminates after 60s

---

## ✅ Acceptance Criteria

All tests should pass with:
- ✅ No JavaScript errors in console
- ✅ Proper file detection and routing
- ✅ Accurate markdown conversion
- ✅ File successfully attaches to Claude
- ✅ Clear error messages on failures
- ✅ Good UX (no freezing, clear feedback)
- ✅ Clean, readable markdown output

---

## 🐞 Known Issues / Future Improvements

Document any issues found during testing:
- [ ] Issue #1: ...
- [ ] Issue #2: ...

---

## 📝 Test Results Template

```
Test Date: YYYY-MM-DD
Tester: [Name]
Browser: Chrome/Edge/Brave [Version]
OS: Windows/macOS/Linux

| Test # | Feature | Status | Notes |
|--------|---------|--------|-------|
| 1 | Text PDF | ✅/❌ | |
| 2 | Scanned PDF | ✅/❌ | |
| 3 | JPEG with text | ✅/❌ | |
...
```
