# Zotero Vocabulary Helper

Zotero plugin for auto dictionary lookup and conditional Notion upload.

## What it does

- When a single English word is selected, plugin auto-queries the dictionary API.
- A result popup is shown beside the selected word (and avoids covering reader annotation popup).
- In PDF reader, the definition popup is an independent bubble shown near the selected word.
- The popup does not auto-close by timer.
- Closing is triggered when the text selection is cleared.
- `Cancel Upload` is a toggle button: click once to cancel upload, click again to re-enable.
- Upload to Notion happens only when:
  - API returns valid result
  - user does not click `Cancel Upload`
  - selection is cleared and popup closes

## Notion fields

Uploaded fields match `vocabulary-helper-extension-main`:

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

- `Edit -> Settings -> Vocabulary Helper`

Fill in:

- Notion API Key
- Notion Database ID

Optional manual trigger:

- `Tools -> Vocabulary Helper: Query Selection`

## Build

```bash
cd /Users/stilenvoyage/Documents/zotero-llm/zotero-vocabulary-helper
zip -r zotero-vocabulary-helper.xpi manifest.json bootstrap.js content README.md
```
