/* eslint-disable no-undef */

(function () {
  const ADDON_ID = "zotero-vocabulary-helper@stilenvoyage.com";
  const PREF_BRANCH = "extensions.zoteroVocabularyHelper.";
  const PREF_NOTION_API_KEY = `${PREF_BRANCH}notionApiKey`;
  const PREF_NOTION_DATABASE_ID = `${PREF_BRANCH}notionDatabaseId`;
  const PREF_LAST_STARTUP_AT = `${PREF_BRANCH}lastStartupAt`;

  const PREF_PANE_SRC = `${rootURI}content/preferences.xhtml`;

  const STYLE_ID = "zvh-popup-style";

  const notionSchemaCache = new Map();
  const readerSessionByInstance = new WeakMap();
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
        notionSchemaCache.clear();
        status.textContent = "Saved";
      };

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

    const sentence = resolveSelectionSentence(reader, selectedText);

    const source = getSourceMeta(reader);
    const key = `${word.toLowerCase()}::${source.url || ""}`;

    let session = readerSessionByInstance.get(reader);
    if (session && session.key !== key) {
      finalizeReaderSession(session);
      session = null;
    }

    if (!session) {
      session = {
        key,
        reader,
        doc: event.doc,
        word,
        sourceTitle: source.title,
        sourceURL: source.url,
        sentence,
        canceled: false,
        closed: false,
        loading: true,
        payload: null,
        mountEl: null,
        monitorId: 0,
      };
      readerSessionByInstance.set(reader, session);
      activeReaderSessions.add(session);
      startReaderSessionMonitor(session);
      queryReaderSession(session);
    }

    const root = event.doc.createElement("div");
    root.className = "zvh-reader-inline";
    event.append(root);
    session.mountEl = root;
    renderReaderSessionMount(session);
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
        sourceTitle: session.sourceTitle,
        sourceURL: session.sourceURL,
        sentence: session.sentence,
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

    if (!skipUpload && !session.canceled && session.payload?.hasResult) {
      uploadToNotion(session.payload).catch((err) => {
        logDebug("reader inline upload failed", err);
      });
    }
  }

  function closeAllReaderSessions(options = {}) {
    for (const session of Array.from(activeReaderSessions)) {
      finalizeReaderSession(session, options);
    }
  }

  function startReaderSessionMonitor(session) {
    const win = session.doc?.defaultView;
    if (!win) {
      return;
    }

    const tick = () => {
      if (session.closed) {
        return;
      }
      if (!isReaderSessionAlive(session)) {
        finalizeReaderSession(session);
        return;
      }
      try {
        session.monitorId = win.requestAnimationFrame(tick);
      } catch (_) {
        session.monitorId = win.setTimeout(tick, 120);
      }
    };

    try {
      session.monitorId = win.requestAnimationFrame(tick);
    } catch (_) {
      session.monitorId = win.setTimeout(tick, 120);
    }
  }

  function resolveSelectionSentence(reader, selectedText) {
    const probe = normalizeWord(selectedText) || (selectedText || "").trim();

    const readerSentence = extractSentenceFromReaderChars(reader, selectedText);
    if (readerSentence) {
      return readerSentence;
    }
    return resolveFallbackWord(selectedText, probe);
  }

  function extractSentenceFromReaderChars(reader, selectedText) {
    try {
      const selection = getActiveReaderSelectionRange(reader, selectedText);
      if (!selection || selection.collapsed) {
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

      const logical = buildReaderLogicalText(chars);
      if (!logical) {
        return "";
      }

      const startOffset = clampOffset(Math.min(selection.anchorOffset, selection.headOffset), chars.length);
      const endOffset = clampOffset(Math.max(selection.anchorOffset, selection.headOffset), chars.length);
      const logicalStart = logical.charToText[startOffset] ?? 0;
      const logicalEnd = logical.charToText[endOffset] ?? logical.text.length;
      const probe = normalizeInlineText(selectedText);
      const sentence = sliceSentenceByOffsets(logical.text, logicalStart, logicalEnd, probe);
      return sentence;
    } catch (_) {
      return "";
    }
  }

  function getActiveReaderSelectionRange(reader, selectedText = "") {
    const ranges = reader?._internalReader?._primaryView?._selectionRanges;
    if (!Array.isArray(ranges) || !ranges.length) {
      return null;
    }

    const active = ranges.filter((range) => range && !range.collapsed);
    if (!active.length) {
      return null;
    }

    const probe = normalizeInlineText(selectedText).toLowerCase();
    if (probe) {
      const exact = active.find((range) => normalizeInlineText(range.text).toLowerCase() === probe);
      if (exact) {
        return exact;
      }

      const fuzzy = active.find((range) => {
        const text = normalizeInlineText(range.text).toLowerCase();
        return text && (text.includes(probe) || probe.includes(text));
      });
      if (fuzzy) {
        return fuzzy;
      }
    }

    const marked = active.find((range) => range.anchor || range.head);
    return marked || active[0];
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

    for (let i = 0; i < chars.length; i += 1) {
      const ch = chars[i] || {};
      charToText[i] = text.length;
      if (!ch.ignorable) {
        text += typeof ch.c === "string" ? ch.c : "";
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

  function resolveFallbackWord(selectedText, fallback = "") {
    const normalized = normalizeWord(selectedText);
    if (normalized) {
      return normalized;
    }
    const firstToken = (selectedText || "").trim().split(/\s+/).find(Boolean) || "";
    const firstWord = normalizeWord(firstToken);
    return firstWord || (fallback || "").trim();
  }

  function normalizeWord(text) {
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
    const notionApiKey = getStringPref(PREF_NOTION_API_KEY, "").trim();
    const notionDatabaseId = getStringPref(PREF_NOTION_DATABASE_ID, "").trim();

    if (!notionApiKey || !notionDatabaseId) {
      logDebug("skip upload: notion config missing");
      return;
    }

    let schema = null;
    try {
      schema = await fetchNotionDatabaseSchema(notionApiKey, notionDatabaseId);
    } catch (err) {
      logDebug("failed to fetch notion schema, fallback to default payload", err);
    }

    const payload = {
      parent: { database_id: notionDatabaseId },
      properties: schema
        ? buildPropertiesFromSchema(schema, entry)
        : buildFallbackProperties(entry),
    };

    const response = await doRequest("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${notionApiKey}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logDebug(`notion upload failed: ${errorText}`);
      return;
    }

    logDebug(`uploaded to notion: ${entry.word}`);
  }

  async function fetchNotionDatabaseSchema(apiKey, dbId) {
    const cacheKey = `${dbId}`;
    if (notionSchemaCache.has(cacheKey)) {
      return notionSchemaCache.get(cacheKey);
    }

    const response = await doRequest(`https://api.notion.com/v1/databases/${dbId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Notion-Version": "2022-06-28",
      },
    });

    if (!response.ok) {
      throw new Error(`schema request failed: ${response.status}`);
    }

    const json = await response.json();
    const props = json?.properties || {};
    notionSchemaCache.set(cacheKey, props);
    return props;
  }

  function buildPropertiesFromSchema(schema, entry) {
    const props = {};

    const titleName = Object.keys(schema).find((name) => schema[name]?.type === "title");
    if (titleName) {
      props[titleName] = {
        title: [{ text: { content: resolveTitleValue(entry) } }],
      };
    }

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

  function resolveTitleValue(entry) {
    return entry.word || "";
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
