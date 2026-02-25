/* eslint-disable no-undef */

(function () {
  const ADDON_ID = "zotero-vocabulary-helper@stilenvoyage.com";
  const PREF_BRANCH = "extensions.zoteroVocabularyHelper.";
  const PREF_NOTION_API_KEY = `${PREF_BRANCH}notionApiKey`;
  const PREF_NOTION_DATABASE_ID = `${PREF_BRANCH}notionDatabaseId`;
  const PREF_LAST_STARTUP_AT = `${PREF_BRANCH}lastStartupAt`;

  const MENU_QUERY_ID = "zvh-menu-query";
  const PREF_PANE_SRC = `${rootURI}content/preferences.xhtml`;

  const POPUP_ID = "zvh-result-popup";
  const STYLE_ID = "zvh-popup-style";

  const notionSchemaCache = new Map();
  const stateByWindow = new WeakMap();
  const readerSessionByInstance = new WeakMap();
  const activeReaderSessions = new Set();

  function getState(win) {
    if (!stateByWindow.has(win)) {
      stateByWindow.set(win, {
        busy: false,
        lastSelectionKey: "",
        lastSelectionAt: 0,
        docs: new WeakSet(),
        cleanupFns: [],
      });
    }
    return stateByWindow.get(win);
  }

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

    for (const win of Zotero.getMainWindows()) {
      // onMainWindowLoad(win); --- IGNORE ---
    }
  }

  function onMainWindowLoad(win) {
    if (!win || !win.document) {
      return;
    }

    const state = getState(win);

    injectStyle(win.document);
    addQueryMenu(win.document, win);
    attachSelectionListeners(win, win.document, state);

    const observer = new win.MutationObserver(() => {
      attachIframeListeners(win, win.document, state);
    });
    observer.observe(win.document.documentElement, {
      childList: true,
      subtree: true,
    });

    state.cleanupFns.push(() => {
      try {
        observer.disconnect();
      } catch (_) {}
    });
  }

  function onMainWindowUnload(win) {
    if (!win || !stateByWindow.has(win)) {
      return;
    }

    closeReaderSessionsForWindow(win, { skipUpload: true });

    const state = getState(win);
    for (const fn of state.cleanupFns) {
      try {
        fn();
      } catch (_) {}
    }

    removePopup(win.document);
    removeStyle(win.document);
    removeQueryMenu(win.document);
    stateByWindow.delete(win);
  }

  async function onShutdown() {
    try {
      if (Zotero.Reader?.unregisterEventListener) {
        Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", ADDON_ID);
      }
    } catch (_) {}

    closeAllReaderSessions({ skipUpload: true });

    for (const win of Zotero.getMainWindows()) {
      onMainWindowUnload(win);
    }

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
    try {
      // event: { doc, reader, append, params: { annotation: { text }, ... } }
      Zotero.debug(`[ZVH] event keys: ${Object.keys(event || {}).join(", ")}`);
      Zotero.debug(`[ZVH] params keys: ${Object.keys(event?.params || {}).join(", ")}`);
      Zotero.debug(`[ZVH] annotation keys: ${Object.keys(event?.params?.annotation || {}).join(", ")}`);
      Zotero.debug(`[ZVH] selected text: ${event?.params?.annotation?.text || ""}`);
      // 若想看完整对象（避免循环引用报错）
      Zotero.debug(`[ZVH] event snapshot: ${JSON.stringify({
        params: event?.params,
        hasDoc: !!event?.doc,
        hasReader: !!event?.reader,
        hasAppend: !!event?.append,
      })}`);
    } catch (e) {
      Zotero.debug(`[ZVH] inspect event failed: ${e}`);
    }

    const selectedText = (event?.params?.annotation?.text || "").trim();// || getSelectionText(event.doc);
    if (!selectedText) {
      Zotero.debug("[ZVH] No selected text found in reader event.");
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

    const context = captureSelectionContext(event.doc, selectedText, {
      hintRect: rectArrayToRect(getReaderSelectionPopup(reader, selectedText)?.rect),
      reader,
      skipRangeSearch: true,
    });
    
    try {
      Zotero.debug(`[ZVH] captured context: ${JSON.stringify({ 
        anchorRect: context.anchorRect,
        avoidRect: context.avoidRect,
        sentence: context.sentence,
      })}`);
    } catch (error) {
      Zotero.debug(`[ZVH] inspect context failed: ${error}`);
    }

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
        sentence: context.sentence,
        selectedText,
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
    } else if (shouldReplaceSentence(session.sentence, context.sentence, session.word)) {
      session.sentence = context.sentence;
      if (session.payload) {
        session.payload.sentence = session.sentence;
      }
    }

    // Mount or update the session UI. 
    // We do this before the async query to ensure the UI shows up as soon as possible, 
    // and also to capture the initial selection context for later comparison.
    mountReaderSessionSection(event.doc, event.append, session);
  }

  function getReaderAnnotationText(reader) {
    try {
      return (reader?._internalReader?._lastView?._selectionPopup?.annotation?.text || "").trim();
    } catch (_) {
      return "";
    }
  }

  function rectArrayToRect(rectLike) {
    if (!rectLike) {
      return null;
    }
    if (Array.isArray(rectLike) && rectLike.length >= 4) {
      const left = Number(rectLike[0]);
      const top = Number(rectLike[1]);
      const right = Number(rectLike[2]);
      const bottom = Number(rectLike[3]);
      if (![left, top, right, bottom].every(Number.isFinite)) {
        return null;
      }
      return {
        left,
        right,
        top,
        bottom,
        width: right - left,
        height: bottom - top,
      };
    }
    return normalizeRect(rectLike);
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

  function buildReaderCloseWhen(reader, selectedText) {
    const selectedWord = (normalizeWord(selectedText) || selectedText || "").toLowerCase();
    return () => {
      try {
        const mainWin = Zotero.getMainWindow?.();
        if (!mainWin || mainWin.Zotero_Tabs?.selectedType !== "reader") {
          return true;
        }
      } catch (_) {
        return true;
      }

      const readerPopup = getReaderSelectionPopup(reader, selectedText);
      const popupRect = rectArrayToRect(readerPopup?.rect);
      if (!readerPopup || !popupRect) {
        return true;
      }
      const liveRaw = ((readerPopup.annotation?.text || "").trim() || getReaderAnnotationText(reader)).trim();
      if (!liveRaw) {
        return true;
      }

      const liveWord = (normalizeWord(liveRaw) || "").toLowerCase();
      if (selectedWord && liveWord && liveWord !== selectedWord) {
        return true;
      }
      if (selectedWord && !liveWord && !liveRaw.toLowerCase().includes(selectedWord)) {
        return true;
      }

      return false;
    };
  }

  function mountReaderSessionSection(doc, append, session) {
    const root = doc.createElement("div");
    root.className = "zvh-reader-inline";
    append(root);
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
      const refreshed = captureSelectionContext(session.doc, session.selectedText || session.word, {
        hintRect: rectArrayToRect(getReaderSelectionPopup(session.reader, session.selectedText)?.rect),
        reader: session.reader,
        skipRangeSearch: true,
      });
      if (shouldReplaceSentence(session.sentence, refreshed.sentence, session.word)) {
        session.sentence = refreshed.sentence;
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
    const popup = getReaderSelectionPopup(session.reader, session.selectedText);
    const rect = rectArrayToRect(popup?.rect);
    if (!popup || !rect) {
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

  function closeReaderSessionsForWindow(win, options = {}) {
    if (!win) {
      return;
    }
    for (const session of Array.from(activeReaderSessions)) {
      try {
        const sessionWin = session.doc?.defaultView;
        const sameWindow =
          sessionWin === win ||
          sessionWin?.top === win ||
          sessionWin?.top === win.top;
        if (sameWindow) {
          finalizeReaderSession(session, options);
        }
      } catch (_) {}
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

  function isElementVisible(el) {
    if (!el || !el.isConnected) {
      return false;
    }
    if (el.hidden) {
      return false;
    }
    const ariaHidden = (el.getAttribute("aria-hidden") || "").toLowerCase();
    if (ariaHidden === "true") {
      return false;
    }
    if (el.closest?.("[hidden], [aria-hidden='true']")) {
      return false;
    }
    const win = el.ownerDocument.defaultView;
    const style = win.getComputedStyle(el);
    const opacity = Number(style.opacity);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
      return false;
    }
    if (Number.isFinite(opacity) && opacity <= 0.01) {
      return false;
    }
    const rect = normalizeRect(el.getBoundingClientRect());
    if (!rect) {
      return false;
    }
    return rect.width >= 2 || rect.height >= 2;
  }

  function addQueryMenu(doc, win) {
    const toolsPopup = doc.getElementById("menu_ToolsPopup");
    if (!toolsPopup || doc.getElementById(MENU_QUERY_ID)) {
      return;
    }

    const queryItem = doc.createXULElement
      ? doc.createXULElement("menuitem")
      : doc.createElement("menuitem");

    queryItem.id = MENU_QUERY_ID;
    queryItem.setAttribute("label", "Vocabulary Helper: Query Selection");
    queryItem.addEventListener("command", () => {
      if (win.Zotero_Tabs?.selectedType === "reader") {
        const readerSelection = buildReaderSelectionContext(win);
        if (!readerSelection) {
          Services.prompt.alert(
            win,
            "Vocabulary Helper",
            "Select text in Reader first so the selection bubble is visible."
          );
          return;
        }
        handleSelection(readerSelection.text, readerSelection.context, { force: true });
        return;
      }

      const selectedText = getBestSelectionText(win);
      if (!selectedText) {
        Services.prompt.alert(win, "Vocabulary Helper", "No selected text found.");
        return;
      }

      const context = captureSelectionContext(win.document, selectedText);
      handleSelection(selectedText, context, { force: true });
    });

    toolsPopup.appendChild(queryItem);
  }

  function buildReaderSelectionContext(win) {
    try {
      const reader = Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
      const doc = reader?._iframeWindow?.document;
      if (!reader || !doc) {
        return null;
      }

      const popupRect =
        rectArrayToRect(getReaderSelectionPopup(reader)?.rect) ||
        getSelectionPopupRect(doc);
      if (!popupRect) {
        return null;
      }

      const text =
        (getReaderSelectionPopup(reader)?.annotation?.text || "").trim() ||
        (reader?._internalReader?._lastView?._selectionPopup?.annotation?.text || "").trim() ||
        getSelectionText(doc);
      if (!text) {
        return null;
      }

      const context = captureSelectionContext(doc, text, {
        hintRect: popupRect,
        reader,
        skipRangeSearch: true,
      });
      context.reader = reader;
      context.closeWhen = buildReaderCloseWhen(reader, text);
      context.getAnchorRect = () => {
        const popup = getReaderSelectionPopup(reader, text);
        return rectArrayToRect(popup?.rect);
      };
      context.getAvoidRect = context.getAnchorRect;

      if (!context.anchorRect || (context.anchorRect.width === 0 && context.anchorRect.height === 0)) {
        context.anchorRect = context.getAnchorRect() || popupRect;
      }

      return { text, context };
    } catch (_) {
      return null;
    }
  }

  function removeQueryMenu(doc) {
    const item = doc.getElementById(MENU_QUERY_ID);
    if (item) {
      item.remove();
    }
  }

  function attachSelectionListeners(win, doc, state) {
    if (!doc || state.docs.has(doc)) {
      return;
    }
    state.docs.add(doc);

    const onMouseUp = () => maybeHandleDocSelection(win, doc);
    const onKeyUp = (event) => {
      if (["Shift", "ArrowLeft", "ArrowRight"].includes(event.key)) {
        maybeHandleDocSelection(win, doc);
      }
    };

    doc.addEventListener("mouseup", onMouseUp, true);
    doc.addEventListener("keyup", onKeyUp, true);

    state.cleanupFns.push(() => {
      try {
        doc.removeEventListener("mouseup", onMouseUp, true);
        doc.removeEventListener("keyup", onKeyUp, true);
      } catch (_) {}
    });

    attachIframeListeners(win, doc, state);
  }

  function attachIframeListeners(win, doc, state) {
    const iframes = doc.querySelectorAll("iframe");
    for (const iframe of iframes) {
      try {
        if (iframe.contentDocument) {
          attachSelectionListeners(win, iframe.contentDocument, state);
        }
      } catch (_) {
        // Ignore cross-origin frames.
      }
    }
  }

  function maybeHandleDocSelection(win, doc) {
    if (win?.Zotero_Tabs?.selectedType === "reader") {
      return;
    }

    const selectedText = getSelectionText(doc);
    if (!selectedText) {
      return;
    }

    const context = captureSelectionContext(doc, selectedText);
    handleSelection(selectedText, context);
  }

  function getSelectionText(doc) {
    try {
      const selection = doc?.getSelection ? doc.getSelection() : null;
      return selection ? selection.toString().trim() : "";
    } catch (_) {
      return "";
    }
  }

  function getBestSelectionText(win) {
    const mainText = getSelectionText(win.document);
    if (mainText) {
      return mainText;
    }

    if (win.Zotero_Tabs?.selectedType === "reader") {
      try {
        const reader = Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
        const annoText = reader?._internalReader?._lastView?._selectionPopup?.annotation?.text;
        if (annoText) {
          return annoText.trim();
        }
        const sel = reader?._iframeWindow?.getSelection?.().toString?.().trim();
        if (sel) {
          return sel;
        }
      } catch (_) {}
    }

    return "";
  }

  function captureSelectionContext(doc, selectedText, options = {}) {
    let range = null;
    let anchorRect = null;
    const probe = normalizeWord(selectedText) || (selectedText || "").trim();

    try {
      const sel = doc.getSelection();
      if (sel && sel.rangeCount > 0) {
        range = sel.getRangeAt(0).cloneRange();
        anchorRect = range.getBoundingClientRect();
      }
    } catch (_) {}

    const hintRect = normalizeRect(options?.hintRect);
    const avoidRect = hintRect || getSelectionPopupRect(doc);
    if (!range && probe && !options?.skipRangeSearch) {
      range = findBestRangeForText(doc, probe, avoidRect);
      if (range) {
        try {
          anchorRect = range.getBoundingClientRect();
        } catch (_) {}
      }
    }

    let sentence = probe;
    const readerSentence = extractSentenceFromReaderChars(options?.reader, selectedText);
    if (readerSentence) {
      sentence = readerSentence;
    } else if (options?.reader) {
      sentence = resolveFallbackWord(selectedText, probe);
    } else {
      try {
        sentence = extractSentence(doc, range, probe, avoidRect);
      } catch (_) {}
    }

    return {
      hostDoc: doc,
      range,
      anchorRect,
      avoidRect,
      sentence,
    };
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

  function getSelectionPopupRect(doc) {
    try {
      const targetDoc = doc;
      const docs = getAncestorDocs(targetDoc);
      for (const ownerDoc of docs) {
        const popups = ownerDoc.querySelectorAll?.(".selection-popup");
        if (!popups || !popups.length) {
          continue;
        }
        for (let i = popups.length - 1; i >= 0; i -= 1) {
          const popup = popups[i];
          if (!isElementVisible(popup)) {
            continue;
          }
          const rect = normalizeRect(popup.getBoundingClientRect());
          if (!rect) {
            continue;
          }
          if (ownerDoc === targetDoc) {
            return rect;
          }
          const converted = convertRectFromAncestorDoc(rect, ownerDoc, targetDoc);
          if (converted) {
            return converted;
          }
        }
      }
    } catch (_) {
    }
    return null;
  }

  function findBestRangeForText(doc, probe, hintRect) {
    const target = (probe || "").trim();
    if (!doc?.body || !target) {
      return null;
    }

    const NodeFilterRef = doc.defaultView?.NodeFilter;
    if (!NodeFilterRef) {
      return null;
    }

    const normalizedHint = normalizeRect(hintRect);
    const hintCenter = normalizedHint
      ? {
        x: (normalizedHint.left + normalizedHint.right) / 2,
        y: (normalizedHint.top + normalizedHint.bottom) / 2,
      }
      : null;

    const lowerTarget = target.toLowerCase();
    const walker = doc.createTreeWalker(
      doc.body,
      NodeFilterRef.SHOW_TEXT,
      {
        acceptNode(node) {
          const value = (node?.nodeValue || "").trim();
          if (!value) {
            return NodeFilterRef.FILTER_SKIP;
          }
          return value.toLowerCase().includes(lowerTarget)
            ? NodeFilterRef.FILTER_ACCEPT
            : NodeFilterRef.FILTER_SKIP;
        },
      }
    );

    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;
    let visited = 0;
    let node = walker.nextNode();

    while (node && visited < 3000) {
      visited += 1;
      const raw = node.nodeValue || "";
      const idx = raw.toLowerCase().indexOf(lowerTarget);
      if (idx >= 0) {
        const rect = normalizeRect(node.parentElement?.getBoundingClientRect?.());
        const score = hintCenter && rect
          ? Math.hypot(
            (rect.left + rect.right) / 2 - hintCenter.x,
            (rect.top + rect.bottom) / 2 - hintCenter.y
          )
          : (best ? bestScore + 1 : 0);

        if (!best || score < bestScore) {
          best = { node, idx };
          bestScore = score;
          if (hintCenter && score <= 12) {
            break;
          }
        }
      }
      node = walker.nextNode();
    }

    if (!best) {
      return null;
    }

    try {
      const range = doc.createRange();
      range.setStart(best.node, best.idx);
      range.setEnd(best.node, best.idx + target.length);
      return range;
    } catch (_) {
      return null;
    }
  }

  function getSelectionRangeRect(doc) {
    try {
      const sel = doc.getSelection?.();
      if (!sel || sel.rangeCount === 0) {
        return null;
      }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect?.();
      if (rect && (rect.width > 0 || rect.height > 0)) {
        return rect;
      }
      const rects = range.getClientRects?.();
      if (rects && rects.length > 0) {
        return rects[0];
      }
    } catch (_) {}
    return null;
  }

  function normalizeRect(rect) {
    if (!rect) {
      return null;
    }
    const left = Number(rect.left);
    const right = Number(rect.right);
    const top = Number(rect.top);
    const bottom = Number(rect.bottom);
    const width = Number(rect.width ?? right - left);
    const height = Number(rect.height ?? bottom - top);
    if (![left, right, top, bottom, width, height].every(Number.isFinite)) {
      return null;
    }
    if (width <= 0 && height <= 0) {
      return null;
    }
    return { left, right, top, bottom, width, height };
  }

  function shiftRect(rect, dx, dy) {
    const normalized = normalizeRect(rect);
    if (!normalized) {
      return null;
    }
    return {
      left: normalized.left + dx,
      right: normalized.right + dx,
      top: normalized.top + dy,
      bottom: normalized.bottom + dy,
      width: normalized.width,
      height: normalized.height,
    };
  }

  function convertRectFromAncestorDoc(rect, fromDoc, toDoc) {
    const normalized = normalizeRect(rect);
    if (!normalized) {
      return null;
    }
    if (!fromDoc || !toDoc || fromDoc === toDoc) {
      return normalized;
    }
    try {
      let converted = normalized;
      let currentWin = toDoc.defaultView;
      const fromWin = fromDoc.defaultView;
      while (currentWin && currentWin !== fromWin) {
        const frameEl = currentWin.frameElement;
        if (!frameEl || !frameEl.getBoundingClientRect) {
          return null;
        }
        const frameRect = normalizeRect(frameEl.getBoundingClientRect());
        if (!frameRect) {
          return null;
        }
        converted = shiftRect(converted, -frameRect.left, -frameRect.top);
        if (!converted) {
          return null;
        }
        currentWin = currentWin.parent;
      }
      return currentWin === fromWin ? converted : null;
    } catch (_) {
      return null;
    }
  }

  function getAncestorDocs(doc) {
    const docs = [];
    if (!doc) {
      return docs;
    }
    docs.push(doc);
    try {
      let currentWin = doc.defaultView;
      while (currentWin && currentWin !== currentWin.top) {
        currentWin = currentWin.parent;
        const parentDoc = currentWin?.document;
        if (parentDoc && !docs.includes(parentDoc)) {
          docs.push(parentDoc);
        }
      }
    } catch (_) {}
    return docs;
  }

  function extractSentence(doc, range, selectedText, hintRect = null) {
    const fallback = (selectedText || "").trim();
    const probe = fallback || range?.toString?.().trim() || "";
    if (!probe) {
      return fallback;
    }

    let best = "";
    const startNode = range?.startContainer || null;
    const parent = startNode?.nodeType === doc.defaultView?.Node?.TEXT_NODE
      ? startNode.parentNode
      : startNode;

    const fullText = (parent?.innerText || parent?.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    if (fullText) {
      const direct = sliceSentenceByProbe(fullText, probe);
      if (!isTooShortSentence(direct, probe)) {
        return direct || fallback;
      }
      best = direct || best;
    }

    const siblingText = extractTextFromSiblingWindow(doc, startNode, probe);
    if (siblingText) {
      const expanded = sliceSentenceByProbe(siblingText, probe);
      if (!isTooShortSentence(expanded, probe)) {
        return expanded || fallback;
      }
      if ((expanded || "").length > (best || "").length) {
        best = expanded;
      }
    }

    const layerText = extractTextFromReaderTextLayer(doc, probe, hintRect, range);
    if (layerText) {
      const layerSentence = sliceSentenceByProbe(layerText, probe);
      if (!isTooShortSentence(layerSentence, probe)) {
        return layerSentence || fallback;
      }
      if ((layerSentence || "").length > (best || "").length) {
        best = layerSentence;
      }
    }

    return best || fallback;
  }

  function isTooShortSentence(sentence, probe) {
    const s = (sentence || "").trim();
    const p = (probe || "").trim();
    if (!s) {
      return true;
    }
    return s.length <= p.length + 2;
  }

  function shouldReplaceSentence(existing, candidate, probe) {
    const current = (existing || "").trim();
    const next = (candidate || "").trim();
    if (!next) {
      return false;
    }
    if (!current) {
      return true;
    }

    const p = (probe || "").trim();
    const currentShort = isTooShortSentence(current, p);
    const nextShort = isTooShortSentence(next, p);
    if (currentShort !== nextShort) {
      return currentShort && !nextShort;
    }
    return next.length > current.length;
  }

  function sliceSentenceByProbe(fullText, probe) {
    const text = (fullText || "").replace(/\s+/g, " ").trim();
    if (!text) {
      return "";
    }

    const idx = text.toLowerCase().indexOf((probe || "").toLowerCase());
    if (idx < 0) {
      return text;
    }

    const before = text.slice(0, idx);
    const start = Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?")) + 1;

    const after = text.slice(idx + probe.length);
    const endMarks = [after.indexOf("."), after.indexOf("!"), after.indexOf("?")].filter((n) => n >= 0);
    const end = endMarks.length
      ? idx + probe.length + Math.min(...endMarks) + 1
      : text.length;

    return text.slice(start, end).trim() || text;
  }

  function extractTextFromSiblingWindow(doc, startNode, probe) {
    try {
      const NodeRef = doc.defaultView?.Node;
      const anchorEl = startNode?.nodeType === NodeRef?.TEXT_NODE ? startNode.parentNode : startNode;
      const parent = anchorEl?.parentNode;
      if (!anchorEl || !parent) {
        return "";
      }

      const nodes = Array.from(parent.childNodes).filter((node) => {
        const text = (node.textContent || "").replace(/\s+/g, " ").trim();
        return text.length > 0;
      });
      if (!nodes.length) {
        return "";
      }

      let index = nodes.findIndex((node) => node === anchorEl || (node.contains && node.contains(anchorEl)));
      if (index < 0 && probe) {
        index = nodes.findIndex((node) => (node.textContent || "").toLowerCase().includes(probe.toLowerCase()));
      }
      if (index < 0) {
        return "";
      }

      const start = Math.max(0, index - 40);
      const end = Math.min(nodes.length, index + 41);
      const chunk = nodes
        .slice(start, end)
        .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      return chunk;
    } catch (_) {
      return "";
    }
  }

  function extractTextFromReaderTextLayer(doc, probe, hintRect, range) {
    try {
      const layers = Array.from(doc.querySelectorAll?.(".textLayer") || []);
      if (!layers.length) {
        return "";
      }

      const normalizedHint = normalizeRect(hintRect);
      const hintCenter = normalizedHint
        ? {
          x: (normalizedHint.left + normalizedHint.right) / 2,
          y: (normalizedHint.top + normalizedHint.bottom) / 2,
        }
        : null;

      let targetLayer = null;
      if (range?.startContainer) {
        const node = range.startContainer;
        const anchorEl = node.nodeType === doc.defaultView?.Node?.TEXT_NODE ? node.parentNode : node;
        targetLayer = anchorEl?.closest?.(".textLayer") || null;
      }

      if (!targetLayer && hintCenter) {
        let bestDistance = Number.POSITIVE_INFINITY;
        for (const layer of layers) {
          const rect = normalizeRect(layer.getBoundingClientRect?.());
          if (!rect) {
            continue;
          }
          const distance = Math.hypot(
            (rect.left + rect.right) / 2 - hintCenter.x,
            (rect.top + rect.bottom) / 2 - hintCenter.y
          );
          if (distance < bestDistance) {
            bestDistance = distance;
            targetLayer = layer;
          }
        }
      }

      if (!targetLayer) {
        targetLayer = layers[0];
      }
      if (!targetLayer) {
        return "";
      }

      const spans = Array.from(targetLayer.querySelectorAll?.("span") || []).filter((el) => {
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        return !!text;
      });
      if (!spans.length) {
        return "";
      }

      const lowerProbe = (probe || "").toLowerCase();
      let index = -1;

      if (range?.startContainer) {
        const node = range.startContainer;
        const anchorEl = node.nodeType === doc.defaultView?.Node?.TEXT_NODE ? node.parentNode : node;
        index = spans.findIndex((el) => el === anchorEl || el.contains?.(anchorEl));
      }

      if (index < 0 && lowerProbe) {
        if (hintCenter) {
          let bestDistance = Number.POSITIVE_INFINITY;
          for (let i = 0; i < spans.length; i += 1) {
            const text = (spans[i].textContent || "").toLowerCase();
            if (!text.includes(lowerProbe)) {
              continue;
            }
            const rect = normalizeRect(spans[i].getBoundingClientRect?.());
            if (!rect) {
              continue;
            }
            const distance = Math.hypot(
              (rect.left + rect.right) / 2 - hintCenter.x,
              (rect.top + rect.bottom) / 2 - hintCenter.y
            );
            if (distance < bestDistance) {
              bestDistance = distance;
              index = i;
            }
          }
        }

        if (index < 0) {
          index = spans.findIndex((el) => (el.textContent || "").toLowerCase().includes(lowerProbe));
        }
      }

      if (index < 0) {
        return "";
      }

      const start = Math.max(0, index - 220);
      const end = Math.min(spans.length, index + 221);
      const chunk = spans
        .slice(start, end)
        .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      return chunk;
    } catch (_) {
      return "";
    }
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

  async function handleSelection(selectedText, context, options = {}) {
    const win = Zotero.getMainWindow();
    if (!win) {
      return;
    }

    const state = getState(win);
    if (state.busy) {
      return;
    }

    const word = normalizeWord(selectedText);
    if (!word) {
      return;
    }

    const source = getSourceMeta(context.reader);
    const key = `${word.toLowerCase()}::${source.url || ""}`;
    const now = Date.now();

    if (!options.force && key === state.lastSelectionKey && now - state.lastSelectionAt < 1200) {
      return;
    }

    state.lastSelectionKey = key;
    state.lastSelectionAt = now;
    state.busy = true;

    try {
      const definition = await fetchDefinition(word);
      const payload = {
        word,
        sourceTitle: source.title,
        sourceURL: source.url,
        sentence: context.sentence,
        hasResult: definition.hasResult,
        phonetic: definition.phonetic,
        meaningRichText: definition.meaningRichText,
        sections: definition.sections,
      };

      await showResultPopup(context.hostDoc || win.document, payload, context, async ({ canceled }) => {
        if (!canceled && payload.hasResult) {
          await uploadToNotion(payload);
        }
      });
    } catch (err) {
      logDebug("handleSelection failed", err);
    } finally {
      state.busy = false;
    }
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
      #${POPUP_ID} {
        position: fixed;
        z-index: 2147483647;
        width: 360px;
        max-height: 70vh;
        overflow: hidden;
        background: #ffffff;
        color: #0f172a;
        border: 1px solid #dbe5ef;
        border-radius: 12px;
        box-shadow: 0 12px 30px rgba(15, 23, 42, 0.18);
        padding: 12px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      #${POPUP_ID} .zvh-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 8px;
      }

      #${POPUP_ID} .zvh-word {
        font-size: 18px;
        font-weight: 700;
        margin: 0;
        color: #0f172a;
      }

      #${POPUP_ID} .zvh-phonetic {
        font-size: 12px;
        color: #475569;
        margin: 0;
      }

      #${POPUP_ID} .zvh-meaning {
        margin-top: 10px;
        max-height: 44vh;
        overflow-y: auto;
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        padding: 10px;
      }

      #${POPUP_ID} .zvh-section {
        margin-bottom: 10px;
      }

      #${POPUP_ID} .zvh-pos {
        font-size: 12px;
        font-weight: 700;
        color: #1d4ed8;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        margin-bottom: 4px;
      }

      #${POPUP_ID} .zvh-def {
        font-size: 13px;
        line-height: 1.5;
        margin-bottom: 3px;
      }

      #${POPUP_ID} .zvh-example {
        font-size: 12px;
        line-height: 1.45;
        color: #64748b;
        font-style: italic;
      }

      #${POPUP_ID} .zvh-actions {
        margin-top: 10px;
        display: flex;
        justify-content: flex-end;
      }

      #${POPUP_ID} .zvh-cancel {
        border: 1px solid #fecaca;
        background: #fef2f2;
        color: #991b1b;
        border-radius: 8px;
        padding: 6px 10px;
        font-size: 12px;
        cursor: pointer;
      }

      #${POPUP_ID} .zvh-cancel.zvh-cancel-off {
        border-color: #cbd5e1;
        background: #f1f5f9;
        color: #475569;
      }

      #${POPUP_ID} .zvh-hint {
        margin: 8px 0 0;
        font-size: 12px;
        color: #64748b;
      }

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

  function removeStyle(doc) {
    const style = doc.getElementById(STYLE_ID);
    if (style) {
      style.remove();
    }
  }

  function removePopup(doc) {
    const el = doc.getElementById(POPUP_ID);
    if (el) {
      el.remove();
    }
  }

  function showResultPopup(doc, payload, context, onClose) {
    return new Promise((resolve) => {
      injectStyle(doc);
      removePopup(doc);

      const win = doc.defaultView;
      const topDoc = (() => {
        try {
          const candidate = win.top?.document;
          return candidate && candidate !== doc ? candidate : null;
        } catch (_) {
          return null;
        }
      })();
      const root = doc.createElement("div");
      root.id = POPUP_ID;

      const head = doc.createElement("div");
      head.className = "zvh-head";

      const wordEl = doc.createElement("p");
      wordEl.className = "zvh-word";
      wordEl.textContent = payload.word;

      const phonetic = doc.createElement("p");
      phonetic.className = "zvh-phonetic";
      phonetic.textContent = payload.phonetic ? `/${payload.phonetic}/` : "";

      head.append(wordEl, phonetic);

      const meaning = doc.createElement("div");
      meaning.className = "zvh-meaning";

      if (!payload.sections.length) {
        const empty = doc.createElement("div");
        empty.className = "zvh-def";
        empty.textContent = "No definition found.";
        meaning.appendChild(empty);
      } else {
        for (const section of payload.sections) {
          const block = doc.createElement("div");
          block.className = "zvh-section";

          const pos = doc.createElement("div");
          pos.className = "zvh-pos";
          pos.textContent = section.partOfSpeech;

          const def = doc.createElement("div");
          def.className = "zvh-def";
          def.textContent = section.definition;

          block.append(pos, def);

          if (section.example) {
            const ex = doc.createElement("div");
            ex.className = "zvh-example";
            ex.textContent = section.example;
            block.appendChild(ex);
          }

          meaning.appendChild(block);
        }
      }

      const actions = doc.createElement("div");
      actions.className = "zvh-actions";

      const cancelBtn = doc.createElement("button");
      cancelBtn.className = "zvh-cancel";
      cancelBtn.textContent = "Cancel Upload";
      actions.appendChild(cancelBtn);

      const hint = doc.createElement("p");
      hint.className = "zvh-hint";
      hint.textContent = payload.hasResult
        ? "Clear selection to close. Upload follows the button state."
        : "No API result. Closing will not upload.";

      root.append(head, meaning, actions, hint);
      doc.documentElement.appendChild(root);

      let fallbackPopupRect =
        normalizeRect(context?.getAvoidRect?.()) ||
        normalizeRect(getSelectionPopupRect(doc));
      let fallbackAnchorRect =
        normalizeRect(context?.getAnchorRect?.()) ||
        normalizeRect(context?.anchorRect) ||
        normalizeRect(getSelectionRangeRect(doc)) ||
        fallbackPopupRect;
      let fallbackAvoidRect =
        normalizeRect(context?.getAvoidRect?.()) ||
        normalizeRect(context?.avoidRect) ||
        fallbackPopupRect;

      let canceled = false;
      let closed = false;
      let suppressClose = false;
      let closeObserver = null;
      let topObserver = null;
      let rafId = 0;
      let monitorRafId = 0;
      const shouldClose = typeof context?.closeWhen === "function"
        ? context.closeWhen
        : () => !getSelectionText(doc);

      const getLiveAnchorRect = () => {
        const byContext = normalizeRect(context?.getAnchorRect?.());
        if (byContext) {
          return byContext;
        }
        const bySelection = normalizeRect(getSelectionRangeRect(doc));
        if (bySelection) {
          return bySelection;
        }
        const byPopup = normalizeRect(getSelectionPopupRect(doc));
        if (byPopup) {
          return byPopup;
        }
        const byRange = normalizeRect(context?.range?.getBoundingClientRect?.());
        if (byRange) {
          return byRange;
        }
        return fallbackAnchorRect;
      };

      const getLiveAvoidRect = () => {
        const byContext = normalizeRect(context?.getAvoidRect?.());
        if (byContext) {
          return byContext;
        }
        const byPopup = normalizeRect(getSelectionPopupRect(doc));
        if (byPopup) {
          return byPopup;
        }
        return fallbackAvoidRect;
      };

      const refreshPopupPosition = () => {
        if (closed || !root.isConnected) {
          return;
        }
        const nextAnchor = getLiveAnchorRect();
        const nextAvoid = getLiveAvoidRect();
        if (nextAnchor) {
          fallbackAnchorRect = nextAnchor;
        }
        if (nextAvoid) {
          fallbackAvoidRect = nextAvoid;
        }
        placePopup(root, doc, nextAnchor, nextAvoid);
      };

      const beginSuppress = () => {
        suppressClose = true;
      };

      const scheduleEvaluateClose = () => {
        if (closed || suppressClose || rafId) {
          return;
        }
        rafId = win.requestAnimationFrame(() => {
          rafId = 0;
          refreshPopupPosition();
          evaluateClose();
        });
      };

      const evaluateClose = () => {
        if (closed || suppressClose) {
          return;
        }
        if (shouldClose()) {
          finish();
        }
      };

      const selectionHandler = () => {
        scheduleEvaluateClose();
      };

      const escapeHandler = (event) => {
        if (event.key === "Escape") {
          finish();
        }
      };

      const mouseDownHandler = () => {
        scheduleEvaluateClose();
      };

      const mouseUpHandler = () => {
        if (suppressClose) {
          suppressClose = false;
          return;
        }
        scheduleEvaluateClose();
      };

      const keyUpHandler = () => {
        scheduleEvaluateClose();
      };

      const blurHandler = () => {
        scheduleEvaluateClose();
      };

      const monitorTick = () => {
        if (closed) {
          return;
        }
        refreshPopupPosition();
        evaluateClose();
        monitorRafId = win.requestAnimationFrame(monitorTick);
      };

      const finish = async () => {
        if (closed) {
          return;
        }
        closed = true;

        if (rafId) {
          try {
            win.cancelAnimationFrame(rafId);
          } catch (_) {}
          rafId = 0;
        }
        if (monitorRafId) {
          try {
            win.cancelAnimationFrame(monitorRafId);
          } catch (_) {}
          monitorRafId = 0;
        }
        doc.removeEventListener("selectionchange", selectionHandler, true);
        doc.removeEventListener("keydown", escapeHandler, true);
        doc.removeEventListener("mousedown", mouseDownHandler, true);
        doc.removeEventListener("mouseup", mouseUpHandler, true);
        doc.removeEventListener("keyup", keyUpHandler, true);
        win.removeEventListener("blur", blurHandler, true);
        root.removeEventListener("mousedown", beginSuppress, true);
        if (topDoc) {
          topDoc.removeEventListener("selectionchange", selectionHandler, true);
          topDoc.removeEventListener("keydown", escapeHandler, true);
          topDoc.removeEventListener("mousedown", mouseDownHandler, true);
          topDoc.removeEventListener("mouseup", mouseUpHandler, true);
          topDoc.removeEventListener("keyup", keyUpHandler, true);
          win.top?.removeEventListener?.("blur", blurHandler, true);
        }
        if (closeObserver) {
          try {
            closeObserver.disconnect();
          } catch (_) {}
        }
        if (topObserver) {
          try {
            topObserver.disconnect();
          } catch (_) {}
        }
        removePopup(doc);

        try {
          await onClose({ canceled });
        } catch (err) {
          logDebug("popup close callback failed", err);
        }

        resolve();
      };

      root.addEventListener("mousedown", beginSuppress, true);
      cancelBtn.addEventListener("click", () => {
        canceled = !canceled;
        if (canceled) {
          cancelBtn.textContent = "Upload Canceled";
          cancelBtn.classList.add("zvh-cancel-off");
        } else {
          cancelBtn.textContent = "Cancel Upload";
          cancelBtn.classList.remove("zvh-cancel-off");
        }
      });
      doc.addEventListener("selectionchange", selectionHandler, true);
      doc.addEventListener("keydown", escapeHandler, true);
      doc.addEventListener("mousedown", mouseDownHandler, true);
      doc.addEventListener("mouseup", mouseUpHandler, true);
      doc.addEventListener("keyup", keyUpHandler, true);
      win.addEventListener("blur", blurHandler, true);
      if (topDoc) {
        topDoc.addEventListener("selectionchange", selectionHandler, true);
        topDoc.addEventListener("keydown", escapeHandler, true);
        topDoc.addEventListener("mousedown", mouseDownHandler, true);
        topDoc.addEventListener("mouseup", mouseUpHandler, true);
        topDoc.addEventListener("keyup", keyUpHandler, true);
        win.top?.addEventListener?.("blur", blurHandler, true);
      }

      closeObserver = new win.MutationObserver(() => {
        scheduleEvaluateClose();
      });
      closeObserver.observe(doc.documentElement, {
        attributes: true,
        childList: true,
        subtree: true,
      });

      if (topDoc) {
        topObserver = new win.MutationObserver(() => {
          scheduleEvaluateClose();
        });
        topObserver.observe(topDoc.documentElement, {
          attributes: true,
          childList: true,
          subtree: true,
        });
      }

      refreshPopupPosition();
      monitorRafId = win.requestAnimationFrame(monitorTick);
      scheduleEvaluateClose();
    });
  }

  function rectIntersects(a, b) {
    if (!a || !b) {
      return false;
    }
    return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
  }

  function placePopup(root, doc, anchorRect, avoidRect) {
    const win = doc.defaultView;
    const margin = 12;

    const width = 360;
    const height = root.offsetHeight || 260;

    let left = win.innerWidth - width - margin;
    let top = margin;

    if (anchorRect && anchorRect.width + anchorRect.height > 0) {
      left = anchorRect.right + 10;
      top = anchorRect.top - 6;

      if (left + width + margin > win.innerWidth) {
        left = anchorRect.left - width - 10;
      }
      if (left < margin) {
        left = margin;
      }

      if (top + height + margin > win.innerHeight) {
        top = win.innerHeight - height - margin;
      }
      if (top < margin) {
        top = margin;
      }

      const candidate = {
        left,
        top,
        right: left + width,
        bottom: top + height,
      };

      if (rectIntersects(candidate, avoidRect)) {
        top = (avoidRect.bottom || top) + 10;
        if (top + height + margin > win.innerHeight) {
          top = Math.max(margin, (avoidRect.top || margin) - height - 10);
        }
      }
    }

    root.style.left = `${Math.round(left)}px`;
    root.style.top = `${Math.round(top)}px`;
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
    maybeSetSourceTitle(schema, props, entry.sourceTitle || "");

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
        title: [{ text: { content: entry.word || entry.sourceTitle || "" } }],
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

  function maybeSetSourceTitle(schema, props, content) {
    if (!content) {
      return;
    }

    for (const name of ["Source Title", "Paper Title"]) {
      const propType = schema[name]?.type;
      if (propType === "rich_text") {
        props[name] = { rich_text: [{ text: { content } }] };
        return;
      }
      if (propType === "title") {
        props[name] = { title: [{ text: { content } }] };
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
      onMainWindowLoad,
      onMainWindowUnload,
      onShutdown,
      onPrefsLoad,
    },
  };
})();
