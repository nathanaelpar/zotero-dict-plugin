/* eslint-disable no-undef */

(function () {
  /*
   * Module overview
   * - This script is the runtime core of the addon and is loaded by bootstrap.js.
   * - It hooks into Zotero Reader selection popup events.
   * - For each valid selected word, it creates/updates a "reader session":
   *   1) capture selection range snapshot (page + offsets)
   *   2) query dictionary API
   *   3) render inline definition UI inside the popup
   *   4) when selection disappears, finalize session and resolve context/meta before upload
   */
  const ADDON_ID = "zotero-vocabulary-helper@stilenvoyage.com";
  const PREF_BRANCH = "extensions.zoteroVocabularyHelper.";
  const PREF_NOTION_API_KEY = `${PREF_BRANCH}notionApiKey`;
  const PREF_NOTION_DATABASE_ID = `${PREF_BRANCH}notionDatabaseId`;
  const PREF_LAST_STARTUP_AT = `${PREF_BRANCH}lastStartupAt`;

  const PREF_PANE_SRC = `${rootURI}content/preferences.xhtml`;

  const STYLE_ID = "zvh-popup-style";

  // Cache Notion database schema by database ID to avoid repeated schema fetches.
  const notionSchemaCache = new Map();
  // Keep one active session per Reader instance. WeakMap prevents memory leaks.
  const readerSessionByInstance = new WeakMap();
  // Track all open sessions so we can close them during shutdown.
  const activeReaderSessions = new Set();

  function registerPrefsPane() {
    try {
      Zotero.PreferencePanes.register({
        pluginID: ADDON_ID,
        src: PREF_PANE_SRC,
        label: "Vocabulary Helper",
      });
    } catch (err) {
      logDebug("registerPrefsPane failed", err);
    }
  }

  function onPrefsLoad(event) {
    try {
      const doc = event.target.ownerDocument;
      const apiInput = doc.getElementById("zvh-notion-api-key");
      const dbInput = doc.getElementById("zvh-notion-database-id");
      const saveBtn = doc.getElementById("zvh-save-settings");
      const status = doc.getElementById("zvh-settings-status");

      if (!apiInput || !dbInput || !saveBtn || !status) {
        return;
      }

      apiInput.value = getStringPref(PREF_NOTION_API_KEY, "");
      dbInput.value = getStringPref(PREF_NOTION_DATABASE_ID, "");

      const save = () => {
        Services.prefs.setStringPref(PREF_NOTION_API_KEY, apiInput.value.trim());
        Services.prefs.setStringPref(PREF_NOTION_DATABASE_ID, dbInput.value.trim());
        // Settings changed, so cached schema may be stale for the new database.
        notionSchemaCache.clear();
        status.textContent = "Saved";
      };

      // Different UI layers may dispatch either "command" or "click".
      saveBtn.addEventListener("command", save);
      saveBtn.addEventListener("click", save);
    } catch (err) {
      logDebug("onPrefsLoad failed", err);
    }
  }

  async function onStartup() {
    Services.prefs.setStringPref(PREF_LAST_STARTUP_AT, new Date().toISOString());

    registerPrefsPane();
    registerReaderSelectionHook();
  }

  async function onShutdown() {
    try {
      if (Zotero.Reader?.unregisterEventListener) {
        Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", ADDON_ID);
      }
    } catch (_) {}

    closeAllReaderSessions({ skipUpload: true });

    delete Zotero.VocabularyHelper;
  }

  function registerReaderSelectionHook() {
    if (!Zotero.Reader?.registerEventListener) {
      return;
    }

    Zotero.Reader.registerEventListener(
      "renderTextSelectionPopup",
      (event) => handleReaderSelection(event),
      ADDON_ID
    );
  }

  /* 
   * Main handler for reader selection popup event
   */
  async function handleReaderSelection(event) {
    const selectedText = (event?.params?.annotation?.text || "").trim();
    if (!selectedText) {
      return;
    }

    const word = normalizeWord(selectedText);
    if (!word) {
      return;
    }

    const reader = event.reader;
    if (!reader || !event.append) {
      return;
    }
    injectStyle(event.doc);

    const selectionSnapshot = captureReaderSelectionSnapshot(reader, selectedText);
    // Session identity: same word in same reader item should reuse one lookup/upload lifecycle.
    const readerItemKey = reader?.itemID ? String(reader.itemID) : "";
    const key = `${word.toLowerCase()}::${readerItemKey}`;

    let session = readerSessionByInstance.get(reader);
    if (session && session.key !== key) {
      finalizeReaderSession(session);
      session = null;
    }

    if (!session) {
      // A session owns async lookup state, UI mount state, and upload decision flags.
      session = {
        key,
        reader,
        doc: event.doc,
        word,
        selectionSnapshot: selectionSnapshot || null,
        canceled: false,
        closed: false,
        loading: true,
        payload: null,
        mountEl: null,
        monitorId: 0,
      };
      readerSessionByInstance.set(reader, session);
      activeReaderSessions.add(session);
      // Start lifecycle monitor and dictionary query in parallel.
      startReaderSessionMonitor(session);
      queryReaderSession(session);
    }

    const root = event.doc.createElement("div");
    root.className = "zvh-reader-inline";
    event.append(root);
    session.mountEl = root;
    renderReaderSessionMount(session);
  }

  function renderReaderSessionMount(session) {
    const root = session?.mountEl;
    if (!root || !root.isConnected || session.closed) {
      return;
    }

    root.replaceChildren();
    const doc = root.ownerDocument;
    const payload = session.payload;
    // Keep reader inline panel visually integrated with Zotero's popup.
    root.style.borderTop = "none";
    root.style.paddingTop = "0";

    const wordEl = doc.createElement("div");
    wordEl.className = "zvh-reader-word";
    wordEl.textContent = payload?.word || session.word;
    root.appendChild(wordEl);

    const phoneticEl = doc.createElement("div");
    phoneticEl.className = "zvh-reader-phonetic";
    phoneticEl.textContent = payload?.phonetic ? `/${payload.phonetic}/` : "";
    root.appendChild(phoneticEl);

    const meaning = doc.createElement("div");
    meaning.className = "zvh-reader-meaning";
    if (session.loading) {
      meaning.textContent = "Loading definition...";
    } else if (!payload?.hasResult || !payload.sections?.length) {
      meaning.textContent = "No definition found.";
    } else {
      const snippets = payload.sections.slice(0, 2);
      for (let i = 0; i < snippets.length; i += 1) {
        const section = snippets[i];
        const pos = section.partOfSpeech ? `[${section.partOfSpeech}] ` : "";
        const line = doc.createElement("div");
        line.textContent = `${pos}${section.definition}`;
        if (i > 0) {
          line.style.marginTop = "2px";
        }
        meaning.appendChild(line);
      }
    }
    root.appendChild(meaning);

    const actions = doc.createElement("div");
    actions.className = "zvh-reader-actions";
    const cancelBtn = doc.createElement("button");
    cancelBtn.className = `zvh-reader-cancel${session.canceled ? " zvh-reader-cancel-off" : ""}`;
    cancelBtn.textContent = session.canceled ? "Upload Canceled" : "Cancel Upload";
    cancelBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      session.canceled = !session.canceled;
      renderReaderSessionMount(session);
    });
    actions.appendChild(cancelBtn);
    root.appendChild(actions);

    const hint = doc.createElement("div");
    hint.className = "zvh-reader-hint";
    hint.textContent = session.loading
      ? "Keep selection until loading completes."
      : "Clear selection to close and trigger upload.";
    root.appendChild(hint);
  }

  async function queryReaderSession(session) {
    try {
      const definition = await fetchDefinition(session.word);
      if (session.closed) {
        return;
      }
      session.loading = false;
      session.payload = {
        word: session.word,
        hasResult: definition.hasResult,
        phonetic: definition.phonetic,
        meaningRichText: definition.meaningRichText,
        sections: definition.sections,
      };
      renderReaderSessionMount(session);
    } catch (err) {
      if (!session.closed) {
        session.loading = false;
        logDebug("queryReaderSession failed", err);
        renderReaderSessionMount(session);
      }
    }
  }

  function startReaderSessionMonitor(session) {
    const win = session.doc?.defaultView;
    if (!win) {
      return;
    }

    // Clearing the selection closes the popup, which finalizes the session.
    const tick = () => {
      if (session.closed) {
        return;
      }
      if (!isReaderSessionAlive(session)) {
        finalizeReaderSession(session);
        return;
      }
      try {
        // requestAnimationFrame is cheap and naturally throttled by the browser.
        session.monitorId = win.requestAnimationFrame(tick);
      } catch (_) {
        // Fallback for environments where requestAnimationFrame is unavailable.
        session.monitorId = win.setTimeout(tick, 120);
      }
    };

    try {
      session.monitorId = win.requestAnimationFrame(tick);
    } catch (_) {
      session.monitorId = win.setTimeout(tick, 120);
    }
  }

  function isReaderSessionAlive(session) {
    const popup = getReaderSelectionPopup(session.reader, session.word);
    if (!popup) {
      return false;
    }

    const selectedWord = session.word.toLowerCase();
    const liveRaw = (popup?.annotation?.text || "").trim().toLowerCase();
    if (!liveRaw) {
      return false;
    }
    const liveWord = (normalizeWord(liveRaw) || "").toLowerCase();
    if (liveWord) {
      return liveWord === selectedWord;
    }
    return liveRaw.includes(selectedWord);
  }

  function getReaderSelectionPopup(reader, selectedText = "") {
    // Try to find the selection popup that best matches the current selected text.
    try {
      const state = reader?._state;
      if (!state) {
        return null;
      }
      const candidates = [
        state.primaryViewSelectionPopup || null,
        state.secondaryViewSelectionPopup || null,
      ].filter(Boolean);
      if (!candidates.length) {
        return null;
      }

      const probe = (selectedText || "").trim().toLowerCase();
      if (probe) {
        const exact = candidates.find((popup) =>
          (popup?.annotation?.text || "").trim().toLowerCase() === probe
        );
        if (exact) {
          return exact;
        }
        const fuzzy = candidates.find((popup) =>
          (popup?.annotation?.text || "").trim().toLowerCase().includes(probe)
        );
        if (fuzzy) {
          return fuzzy;
        }
      }
      return candidates[0] || null;
    } catch (_) {
      return null;
    }
  }

  function captureReaderSelectionSnapshot(reader, selectedText = "") {
    // These are Zotero internal/private fields; guard every access because shape may change.
    // expected ranges: [{ pageIndex, anchorOffset, headOffset, text }, ...]
    const ranges = reader?._internalReader?._primaryView?._selectionRanges;
    if (!Array.isArray(ranges) || !ranges.length) {
      return null;
    }

    // Filter out collapsed/empty ranges
    const active = ranges.filter((range) => range && !range.collapsed); 
    if (!active.length) {
      return null;
    }

    // Look for the range that range.text best matches the selected text
    const fallbackText = normalizeInlineText(selectedText);
    const probe = fallbackText.toLowerCase();
    const exactMatch = probe
      ? active.find((candidate) => normalizeInlineText(candidate.text).toLowerCase() === probe) || null
      : null;
    const fuzzyMatch =
      !exactMatch && probe
        ? active.find((candidate) => {
            const text = normalizeInlineText(candidate.text).toLowerCase();
            return text && (text.includes(probe) || probe.includes(text));
          }) || null
        : null;
    // exactMatch > fuzzyMatch > any range with anchor/head > first range
    const range = exactMatch || fuzzyMatch || active.find((candidate) => candidate.anchor || candidate.head) || active[0];
    if (!range) {
      return null;
    }

    const pageIndex = Number(range.pageIndex);
    const anchorOffset = Number(range.anchorOffset);
    const headOffset = Number(range.headOffset);
    if (
      !Number.isInteger(pageIndex) ||
      pageIndex < 0 ||
      !Number.isFinite(anchorOffset) ||
      !Number.isFinite(headOffset)
    ) {
      return null;
    }

    return {
      pageIndex,
      anchorOffset,
      headOffset,
      text: normalizeInlineText(range.text || fallbackText),
    };
  }

  function finalizeReaderSession(session, options = {}) {
    if (!session || session.closed) {
      return;
    }
    session.closed = true;
    const skipUpload = !!options.skipUpload;

    const win = session.doc?.defaultView;
    if (session.monitorId && win) {
      try {
        win.cancelAnimationFrame(session.monitorId);
      } catch (_) {
        try {
          win.clearTimeout(session.monitorId);
        } catch (_) {}
      }
      session.monitorId = 0;
    }

    const active = readerSessionByInstance.get(session.reader);
    if (active === session) {
      readerSessionByInstance.delete(session.reader);
    }
    activeReaderSessions.delete(session);

    // Upload only after session closes, and only when user did not cancel and lookup succeeded.
    if (!skipUpload && !session.canceled && session.payload?.hasResult) {
      const uploadPayload = buildSessionUploadPayload(session);
      uploadToNotion(uploadPayload).catch((err) => {
        logDebug("reader inline upload failed", err);
      });
    }
  }

  function closeAllReaderSessions(options = {}) {
    for (const session of Array.from(activeReaderSessions)) {
      finalizeReaderSession(session, options);
    }
  }

  function buildSessionUploadPayload(session) {
    const base = session?.payload || {};
    const fallbackWord = session?.word || "";
    const sentence = extractSentenceFromReaderChars(session.reader, session.selectionSnapshot) || fallbackWord;
    const source = getSourceMeta(session?.reader);

    return {
      ...base,
      word: base.word || session?.word || "",
      sentence,
      sourceTitle: source.title || "",
      sourceURL: source.url || null,
    };
  }

  function extractSentenceFromReaderChars(reader, selectionSnapshot = null) {
    // Locate the selected text's page and raw PDF chars, then expand to sentence boundaries.
    try {
      const selection = selectionSnapshot;
      if (!selection) {
        return "";
      }

      const pageIndex = Number(selection.pageIndex);
      if (!Number.isInteger(pageIndex) || pageIndex < 0) {
        return "";
      }

      const chars = getReaderPageChars(reader, pageIndex);
      if (!chars?.length) {
        return "";
      }

      // Selection offsets are based on raw PDF chars, so we build a logical text view first.
      const logical = buildReaderLogicalText(chars);
      if (!logical) {
        return "";
      }

      const startOffset = clampOffset(Math.min(selection.anchorOffset, selection.headOffset), chars.length);
      const endOffset = clampOffset(Math.max(selection.anchorOffset, selection.headOffset), chars.length);
      const logicalStart = logical.charToText[startOffset] ?? 0;
      const logicalEnd = logical.charToText[endOffset] ?? logical.text.length;
      const probe = normalizeInlineText(selection.text || "");
      // Expand the selected span to sentence boundaries.
      const sentence = sliceSentenceByOffsets(logical.text, logicalStart, logicalEnd, probe);
      return sentence;
    } catch (_) {
      return "";
    }
  }

  function getReaderPageChars(reader, pageIndex) {
    try {
      const pdfPages = reader?._internalReader?._primaryView?._pdfPages;
      const page = pdfPages?.[pageIndex];
      return Array.isArray(page?.chars) ? page.chars : null;
    } catch (_) {
      return null;
    }
  }

  function buildReaderLogicalText(chars) {
    if (!Array.isArray(chars) || !chars.length) {
      return null;
    }

    const charToText = new Array(chars.length + 1).fill(0);
    let text = "";

    // Build "user-visible" text and a mapping from raw char index -> logical text offset.
    for (let i = 0; i < chars.length; i += 1) {
      const ch = chars[i] || {};
      charToText[i] = text.length;
      if (!ch.ignorable) {
        text += typeof ch.c === "string" ? ch.c : "";
        // Seperation properties are recorded on char before the break.
        if (ch.spaceAfter || ch.lineBreakAfter || ch.paragraphBreakAfter) {
          text += " ";
        }
      }
    }

    charToText[chars.length] = text.length;
    return { text, charToText };
  }

  function clampOffset(value, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      return 0;
    }
    return Math.max(0, Math.min(max, Math.floor(n)));
  }

  function normalizeInlineText(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function sliceSentenceByOffsets(text, logicalStart, logicalEnd, probe = "") {
    const raw = text || "";
    if (!raw) {
      return "";
    }

    const start = clampOffset(logicalStart, raw.length);
    const end = clampOffset(logicalEnd, raw.length);
    const pivot = Math.min(start, end);
    const searchFrom = Math.max(pivot, end);
    // Support both English and Chinese sentence punctuation.
    const marks = [".", "!", "?", "。", "！", "？"];

    let sentenceStart = 0;
    for (const mark of marks) {
      const idx = raw.lastIndexOf(mark, Math.max(0, pivot - 1));
      if (idx >= sentenceStart) {
        sentenceStart = idx + 1;
      }
    }

    let sentenceEnd = raw.length;
    for (const mark of marks) {
      const idx = raw.indexOf(mark, searchFrom);
      if (idx >= 0 && idx + 1 < sentenceEnd) {
        sentenceEnd = idx + 1;
      }
    }

    let sentence = normalizeInlineText(raw.slice(sentenceStart, sentenceEnd));
    if (!sentence && end > start) {
      sentence = normalizeInlineText(raw.slice(start, end));
    }
    if (!sentence) {
      sentence = normalizeInlineText(probe);
    }
    return sentence;
  }

  function normalizeWord(text) {
    // Keep only plain English-like tokens (letters plus apostrophe/hyphen).
    // This avoids sending long phrases/noisy selections to dictionary API.
    const cleaned = (text || "").trim().replace(/[“”"'`]/g, "");
    if (!cleaned || cleaned.length > 64) {
      return null;
    }
    if (!/^[A-Za-z][A-Za-z'-]*$/.test(cleaned)) {
      return null;
    }
    return cleaned;
  }

  function getSourceMeta(reader) {
    let title = "";
    let url = null;

    try {
      if (reader?.itemID) {
        const item = Zotero.Items.get(reader.itemID);
        if (item) {
          const meta = resolveItemSourceMeta(item);
          title = meta.title;
          url = meta.url;
        }
      }
    } catch (_) {}

    if (!title || !url) {
      try {
        const pane = Zotero.getMainWindow()?.ZoteroPane;
        const items = pane?.getSelectedItems?.() || [];
        const item = items[0];
        if (item) {
          const fallbackMeta = resolveItemSourceMeta(item);
          title = title || fallbackMeta.title;
          url = url || fallbackMeta.url;
        }
      } catch (_) {}
    }

    return { title, url };
  }

  // If item is attachment, prefer parent item's bibliographic metadata.
  function resolveItemSourceMeta(item) {
    if (!item) {
      return { title: "", url: null };
    }

    const itemTitle = item.getField("title") || "";
    const itemURL = item.getField("url") || null;

    if (item.isAttachment?.() && item.parentItemID) {
      try {
        const parent = Zotero.Items.get(item.parentItemID);
        if (parent) {
          return {
            title: parent.getField("title") || itemTitle,
            url: parent.getField("url") || itemURL || null,
          };
        }
      } catch (_) {}
    }

    return { title: itemTitle, url: itemURL };
  }

  async function fetchDefinition(word) {
    const endpoint = `https://lumetrium.com/dictionary-api/v1/entries/en/${encodeURIComponent(word)}`;

    try {
      const response = await doRequest(endpoint);
      if (!response.ok) {
        return {
          hasResult: false,
          phonetic: "",
          sections: [],
          meaningRichText: [],
        };
      }

      const data = await response.json();
      if (!Array.isArray(data) || data.length === 0) {
        return {
          hasResult: false,
          phonetic: "",
          sections: [],
          meaningRichText: [],
        };
      }

      const entry = data[0] || {};
      const phonetic = entry.phonetic || "";
      const meaning = entry.meaning || {};

      const sections = [];
      const richTexts = [];

      for (const partOfSpeech of Object.keys(meaning)) {
        const definitions = Array.isArray(meaning[partOfSpeech]?.definitions)
          ? meaning[partOfSpeech].definitions
          : [];

        for (const defObj of definitions) {
          const definition = (defObj?.definition || "").trim();
          const example = (defObj?.example || "").trim();
          if (!definition) {
            continue;
          }

          sections.push({
            partOfSpeech,
            definition,
            example,
          });

          // Build Notion rich_text blocks once so upload payload can reuse them directly.
          richTexts.push({
            type: "text",
            text: { content: `${partOfSpeech}\n` },
            annotations: { bold: true },
          });
          richTexts.push({
            type: "text",
            text: { content: `${definition}\n` },
          });
          if (example) {
            richTexts.push({
              type: "text",
              text: { content: `${example}\n` },
              annotations: { italic: true, color: "gray" },
            });
          }
          richTexts.push({ type: "text", text: { content: "\n" } });
        }
      }

      return {
        hasResult: sections.length > 0,
        phonetic,
        sections,
        meaningRichText: richTexts,
      };
    } catch (err) {
      logDebug("fetchDefinition failed", err);
      return {
        hasResult: false,
        phonetic: "",
        sections: [],
        meaningRichText: [],
      };
    }
  }

  function injectStyle(doc) {
    if (doc.getElementById(STYLE_ID)) {
      return;
    }

    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .selection-popup .zvh-reader-inline {
        margin-top: 6px;
        border-top: 1px solid #d7dad7;
        padding-top: 6px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 11px;
      }

      .selection-popup .zvh-reader-word {
        font-weight: 700;
        color: #0f172a;
      }

      .selection-popup .zvh-reader-phonetic {
        font-size: 10px;
        color: #475569;
      }

      .selection-popup .zvh-reader-meaning {
        line-height: 1.35;
        color: #0f172a;
      }

      .selection-popup .zvh-reader-actions {
        display: flex;
        justify-content: flex-end;
      }

      .selection-popup .zvh-reader-cancel {
        border: 1px solid #fecaca;
        background: #fef2f2;
        color: #991b1b;
        border-radius: 6px;
        padding: 2px 6px;
        font-size: 10px;
        cursor: pointer;
      }

      .selection-popup .zvh-reader-cancel.zvh-reader-cancel-off {
        border-color: #cbd5e1;
        background: #f1f5f9;
        color: #475569;
      }

      .selection-popup .zvh-reader-hint {
        color: #64748b;
        font-size: 10px;
      }
    `;

    doc.documentElement.appendChild(style);
  }

  async function uploadToNotion(entry) {
    const notionConfig = getNotionConfig();
    if (!notionConfig) {
      logDebug("skip upload: notion config missing");
      return;
    }

    // Adapt payload to actual database schema when possible, fallback to default field names.
    const properties = await resolveNotionProperties(notionConfig, entry);
    const payload = { parent: { database_id: notionConfig.databaseId }, properties };

    const response = await doRequest("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: buildNotionHeaders(notionConfig.apiKey, true),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logDebug(`notion upload failed: ${errorText}`);
      return;
    }

    logDebug(`uploaded to notion: ${entry.word}`);
  }

  function getNotionConfig() {
    const apiKey = getStringPref(PREF_NOTION_API_KEY, "").trim();
    const databaseId = getStringPref(PREF_NOTION_DATABASE_ID, "").trim();
    if (!apiKey || !databaseId) {
      return null;
    }
    return { apiKey, databaseId };
  }

  function buildNotionHeaders(apiKey, withJSON = false) {
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": "2022-06-28",
    };
    if (withJSON) {
      headers["Content-Type"] = "application/json";
    }
    return headers;
  }

  async function resolveNotionProperties(notionConfig, entry) {
    try {
      const schema = await fetchNotionDatabaseSchema(notionConfig.apiKey, notionConfig.databaseId);
      return buildPropertiesFromSchema(schema, entry);
    } catch (err) {
      // Schema fetch can fail due to permissions/network; fallback keeps upload functional.
      logDebug("failed to fetch notion schema, fallback to default payload", err);
      return buildFallbackProperties(entry);
    }
  }

  async function fetchNotionDatabaseSchema(apiKey, dbId) {
    if (notionSchemaCache.has(dbId)) {
      return notionSchemaCache.get(dbId);
    }

    const response = await doRequest(`https://api.notion.com/v1/databases/${dbId}`, {
      method: "GET",
      headers: buildNotionHeaders(apiKey),
    });

    if (!response.ok) {
      throw new Error(`schema request failed: ${response.status}`);
    }

    const json = await response.json();
    const props = json?.properties || {};
    // Cache schema for this run to reduce Notion API calls.
    notionSchemaCache.set(dbId, props);
    return props;
  }

  function buildPropertiesFromSchema(schema, entry) {
    const props = {};

    const titleName = Object.keys(schema).find((name) => schema[name]?.type === "title");
    if (titleName) {
      props[titleName] = {
        title: [{ text: { content: entry.word || "" } }],
      };
    }

    // Try common alias names so this addon works with slightly different database templates.
    maybeSetRichText(schema, props, ["Word", "Vocabulary", "Selected Word"], entry.word || "");
    maybeSetRichText(schema, props, ["Phonetic"], entry.phonetic ? `/${entry.phonetic}/` : "");
    maybeSetRichTextArray(schema, props, ["Meaning"], entry.meaningRichText || []);
    maybeSetRichText(schema, props, ["Sentence", "Context"], entry.sentence || "");
    maybeSetRichText(schema, props, ["Source Title", "Paper Title"], entry.sourceTitle || "");

    maybeSetURL(schema, props, ["Source URL", "URL"], entry.sourceURL || null);
    maybeSetURL(schema, props, ["Jump Back", "JumpBack"], entry.sourceURL || null);

    maybeSetDate(schema, props, ["Time", "Date"], new Date().toISOString());

    return props;
  }

  function buildFallbackProperties(entry) {
    return {
      Word: {
        title: [{ text: { content: entry.word || "" } }],
      },
      Phonetic: {
        rich_text: [{ text: { content: entry.phonetic ? `/${entry.phonetic}/` : "" } }],
      },
      Meaning: {
        rich_text: entry.meaningRichText || [],
      },
      Sentence: {
        rich_text: [{ text: { content: entry.sentence || "" } }],
      },
      "Source Title": {
        rich_text: [{ text: { content: entry.sourceTitle || "" } }],
      },
      "Source URL": {
        url: entry.sourceURL || null,
      },
      "Jump Back": {
        url: entry.sourceURL || null,
      },
      Time: {
        date: { start: new Date().toISOString() },
      },
    };
  }

  function maybeSetRichText(schema, props, names, content) {
    if (!content) {
      return;
    }

    for (const name of names) {
      if (schema[name]?.type === "rich_text") {
        props[name] = { rich_text: [{ text: { content } }] };
        return;
      }
    }
  }

  function maybeSetRichTextArray(schema, props, names, richTextArray) {
    if (!Array.isArray(richTextArray) || !richTextArray.length) {
      return;
    }

    for (const name of names) {
      if (schema[name]?.type === "rich_text") {
        props[name] = { rich_text: richTextArray };
        return;
      }
    }
  }

  function maybeSetURL(schema, props, names, url) {
    for (const name of names) {
      if (schema[name]?.type === "url") {
        props[name] = { url: url || null };
        return;
      }
    }
  }

  function maybeSetDate(schema, props, names, isoTime) {
    for (const name of names) {
      if (schema[name]?.type === "date") {
        props[name] = { date: { start: isoTime } };
        return;
      }
    }
  }

  function getStringPref(prefName, fallback) {
    try {
      return Services.prefs.getStringPref(prefName, fallback);
    } catch (_) {
      return fallback;
    }
  }

  async function doRequest(url, options = {}) {
    if (typeof fetch === "function") {
      return fetch(url, options);
    }

    // Fallback path for environments where global fetch is unavailable.
    const method = options.method || "GET";
    const headers = options.headers || {};
    const body = options.body;

    const response = await Zotero.HTTP.request(method, url, {
      headers,
      body,
      responseType: "text",
    });

    const status = response.status;
    const responseText = response.responseText || response.response || "";

    return {
      ok: status >= 200 && status < 300,
      status,
      async text() {
        return responseText;
      },
      async json() {
        return JSON.parse(responseText || "null");
      },
    };
  }

  function logDebug(msg, err) {
    try {
      Zotero.debug(`[VocabularyHelper] ${msg}`);
      if (err) {
        Zotero.debug(`[VocabularyHelper] ${String(err)}`);
      }
    } catch (_) {}
  }

  Zotero.VocabularyHelper = {
    hooks: {
      onStartup,
      onShutdown,
      onPrefsLoad,
    },
  };
})();
