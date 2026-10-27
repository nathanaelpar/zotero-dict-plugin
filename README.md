# Zotero Vocabulary Helper

Zotero plugin for automatic dictionary and Wikipedia lookups in the PDF reader.

Fork of STILatPKU/zotero-vocabulary-helper

## What it does

- Select a single English word in the PDF reader to see its pronunciation and definitions in the selection popup.
- Select several words (up to 8) to see a short summary of the matching Wikipedia article.
  - If the selection isn't an article title, the top Wikipedia search result is shown, labeled `Closest Wikipedia match`.
  - Single words the dictionary doesn't know (often names) also fall back to Wikipedia.
- `Read more on Wikipedia` opens the full article in your browser.
- Popup colors follow Zotero's light and dark themes.

## Quick Start

1. Open Zotero and go to `Tools -> Plugins -> (Settings Icon) -> Install Plugin From File...`. Select the `.xpi` package.
2. Open a PDF in Zotero Reader and select a word or a short phrase.
3. The definition or Wikipedia summary appears in the selection popup.

No settings or accounts are needed.

## Build

```bash
cd /[your-path-to]/zotero-vocabulary-helper
zip -r zotero-vocabulary-helper.xpi manifest.json bootstrap.js content
```

## Requirements

- Zotero 8.0 – 9.0.x (Suggested)
