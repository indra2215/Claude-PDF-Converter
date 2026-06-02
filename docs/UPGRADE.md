# ISR-CONVERTER - Upgrading to v2.0.0

**Created by Indra**

## What's New? 🎉

Version 2.0.0 adds support for **5 new file formats** beyond PDF:

- 🖼️ **Images** (JPEG, PNG, GIF, WebP, BMP, TIFF) - with EXIF metadata + OCR
- 📊 **CSV** - converts to Markdown tables (limited to 50 rows for optimal Claude performance)
- { } **JSON** - formatted code + auto-table generation
- 📋 **XML** - structured content extraction
- 🌐 **HTML** - clean article extraction

The extension has been renamed to **"ISR-CONVERTER - Universal Document Converter"**.

---

## For Existing Users

### Method 1: Replace Files (Recommended)

1. **Backup your current installation** (optional, but recommended)
   - Make a copy of your current `Claude-PDF-Converter` folder

2. **Download the new version**
   - Download the latest code from the repository
   - Extract to the same location (or a new location)

3. **Reload in browser**
   - Open `chrome://extensions/` (or `edge://extensions/`)
   - Find "ISR-CONVERTER" in the list
   - Click the **Reload** icon (circular arrow)
   - Verify the version shows **2.0.0**

4. **Test it**
   - Go to [claude.ai](https://claude.ai)
   - Try uploading a CSV or JSON file
   - You should see the new format detection working!

### Method 2: Git Pull (For Git Users)

```bash
cd Claude-PDF-Converter
git pull origin main
```

Then reload in browser as described above.

---

## For New Users

Follow the standard installation instructions in README.md:

1. Download/clone the repository
2. Open `chrome://extensions/`
3. Enable "Developer mode"
4. Click "Load unpacked"
5. Select the folder

---

## Compatibility Notes

- ✅ **Backward compatible** - All PDF features work exactly as before
- ✅ **No breaking changes** - Your existing workflow is unchanged
- ✅ **New features are additive** - Simply works with more file types now

---

## What Changed Internally?

For developers interested in the architecture:

### New Files
- `test-samples/` - Sample files for testing new formats
- `TESTING.md` - Comprehensive testing guide
- `UPGRADE.md` - This file

### Modified Files
- `content.js` - Added 5 new converter functions (image, CSV, JSON, XML, HTML)
- `manifest.json` - Version bump to 2.0.0, updated description
- `popup.html` - Updated to show all supported formats
- `README.md` - Comprehensive rewrite with new features documented

### No Changes
- `styles.css` - UI styling unchanged (works with new features)
- `lib/` folder - PDF.js and Tesseract.js unchanged
- Icon files unchanged

---

## Testing Your Upgrade

Quick smoke test:

1. ✅ Upload a PDF → Should work as before
2. ✅ Upload `test-samples/sample.csv` → Should convert to table (limited to 50 rows)
3. ✅ Upload `test-samples/sample.json` → Should show formatted JSON
4. ✅ Check browser console → Should see: "ISR-CONVERTER loaded"

If all 4 work, you're good to go!

---

## Troubleshooting

### "Extension doesn't detect new file types"

**Solution:** Make sure you **reloaded** the extension after updating:
- Go to `chrome://extensions/`
- Find the extension
- Click the reload icon

### "Toast still says old name"

**Solution:** Hard refresh Claude.ai:
- Press `Ctrl+Shift+R` (Windows/Linux) or `Cmd+Shift+R` (Mac)
- Or clear your browser cache for claude.ai

### "Getting JavaScript errors"

**Solution:** 
1. Check that ALL files were updated (not a partial update)
2. Make sure no old version is loaded in another profile
3. Check browser console for specific error details

### "File input button not working"

**Solution:**
- Claude.ai may have changed their UI
- The extension patches file inputs dynamically, so it should self-heal
- If not, report an issue with browser console logs

---

## Need Help?

- 📖 Read the full [README.md](README.md)
- 🧪 Follow the [TESTING.md](TESTING.md) guide
- 🐛 Check the browser console for errors
- 💬 Open an issue on GitHub with:
  - Browser version
  - Extension version
  - Steps to reproduce
  - Console logs

---

## Rollback Instructions

If you need to go back to v1.2.0:

1. Download v1.2.0 from releases (or restore your backup)
2. Replace the files
3. Reload the extension
4. Hard refresh claude.ai

---

## What's Next?

The roadmap includes:

**Phase 2** (Planned):
- 📄 Microsoft Office files (Word, Excel, PowerPoint)
- 📚 EPUB (e-books)
- 🗜️ ZIP archive handling

**Phase 3** (Future):
- 🌐 URL/web page conversion
- 🎵 Audio transcription
- 🎥 Video metadata extraction

Stay tuned!
