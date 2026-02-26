# Zotero Vocabulary Helper

Zotero plugin for auto dictionary lookup and conditional Notion upload.

## What it does

- Automatically queries dictionary API when a word is selected in the PDF reader.
- Render an inline definition panel in the selection popup.
- Upload to Notion vocabulary database when selection is cleared.
- `Cancel Upload` is a toggle button: click once to cancel upload, click again to re-enable.
- Upload to Notion happens only when:
  - API returns valid result
  - user does not click `Cancel Upload`
  - selection is cleared and popup closes

## Quick Start

1. Open Zotero and go to `Tools -> Plugins -> (Settings Icon) -> Install Plugin From File...`. Select the `.xpi` package.
2. Go to `Zotero -> Settings... -> Vocabulary Helper`. Enter your Notion API Key and Notion Database ID.
3. Open a PDF in Zotero Reader and select a single English word.
4. Wait for the inline definition to load.
5. Clear the selection to trigger upload.

## Notion fields required

Uploaded fields:

- `Word`
- `Phonetic`
- `Meaning`
- `Sentence`
- `Source Title`
- `Source URL`
- `Jump Back`
- `Time`

`Source URL` and `Jump Back` both use the Zotero item's `URL` field.
`Sentence` stores the sentence/context containing the selected word.
`Word` stores the selected word, and `Source Title` stores the Zotero item title.

## Settings

Open in Zotero:

- `Zotero -> Settings... -> Vocabulary Helper`

Fill in:

- Notion API Key
- Notion Database ID

## Build

```bash
cd /[your-path-to]/zotero-vocabulary-helper
zip -r zotero-vocabulary-helper.xpi manifest.json bootstrap.js content README.md
```

## Requirements

- Zotero >= 8.0

Tested on Zotero 8.0.3.