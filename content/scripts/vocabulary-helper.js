/* eslint-disable no-undef */

(function () {
  /*
   * Module overview
   * - This script is the runtime core of the addon and is loaded by bootstrap.js.
   * - It hooks into Zotero Reader selection popup events.
   * - For each valid selection it:
   *   1) looks up a single word in the dictionary API
   *   2) looks up several words (or a word the dictionary doesn't know) on Wikipedia
   *   3) renders the definition or summary inline in the popup
   */
  const ADDON_ID = "zotero-vocabulary-helper@stilenvoyage.com";
  const STYLE_ID = "zvh-popup-style";

  // Longer selections are usually highlighting, not lookups, so they are ignored.
  const MAX_PHRASE_WORDS = 8;
  const MAX_PHRASE_LENGTH = 100;
  const WIKIPEDIA_EXTRACT_MAX_LENGTH = 300;
  const WIKIPEDIA_HEADERS = {
    "Api-User-Agent": "ZoteroVocabularyHelper (https://github.com/STILatPKU/zotero-vocabulary-helper)",
  };

  // The reader re-renders the popup for the same selection, so cache lookups by query.
  const MAX_CACHED_LOOKUPS = 100;
  const lookupCache = new Map();

  async function onStartup() {
    registerReaderSelectionHook();
  }

  async function onShutdown() {
    // Zotero removes reader listeners registered with our plugin ID when the plugin shuts down.
    // Don't call Zotero.Reader.unregisterEventListener here: it takes a handler, not a plugin ID,
    // and its filter would drop every other plugin's reader listeners.
    lookupCache.clear();

    delete Zotero.VocabularyHelper;
  }

  function registerReaderSelectionHook() {
    if (!Zotero.Reader?.registerEventListener) {
      return;
    }

    // When the addon is updated in place, Zotero starts it twice without shutting down the first
    // instance, which would leave two popups per selection. Drop any listener we already registered.
    Zotero.Reader._unregisterEventListenerByPluginID?.(ADDON_ID);
    Zotero.Reader.registerEventListener(
      "renderTextSelectionPopup",
      (event) => handleReaderSelection(event),
      ADDON_ID
    );
  }

  /*
   * Main handler for reader selection popup event
   */
  function handleReaderSelection(event) {
    const query = parseSelection(event?.params?.annotation?.text);
    if (!query || !event.doc || !event.append) {
      return;
    }
    injectStyle(event.doc);

    // append() must be called synchronously; the lookup fills the mount in later.
    const root = event.doc.createElement("div");
    root.className = "zvh-reader-inline";
    event.append(root);
    renderMessage(root, query.text, "Looking up...");

    lookup(query).then(
      (result) => renderResult(root, query, result),
      (err) => {
        logDebug("lookup failed", err);
        renderMessage(root, query.text, "Couldn't reach the dictionary or Wikipedia.");
      }
    );
  }

  function parseSelection(text) {
    // Drop surrounding quotes, brackets and punctuation picked up with the selection.
    const cleaned = normalizeInlineText(text)
      .replace(/^["'“”‘’`([{]+/, "")
      .replace(/["'“”‘’`)\]},.;:!?]+$/, "");
    if (!cleaned || cleaned.length > MAX_PHRASE_LENGTH) {
      return null;
    }

    const words = cleaned.split(" ");
    if (words.length === 1) {
      const word = normalizeWord(cleaned);
      if (word) {
        return { text: word, isWord: true };
      }
    }
    if (words.length > MAX_PHRASE_WORDS || !/[A-Za-z]/.test(cleaned)) {
      return null;
    }
    // Phrases and single tokens that aren't plain words (e.g. "CRISPR-Cas9") go to Wikipedia.
    return { text: cleaned, isWord: false };
  }

  function lookup(query) {
    const key = `${query.isWord ? "word" : "phrase"}::${query.text.toLowerCase()}`;
    let pending = lookupCache.get(key);
    if (!pending) {
      pending = runLookup(query).catch((err) => {
        // Don't cache failures (e.g. offline) so the next selection retries.
        lookupCache.delete(key);
        throw err;
      });
      lookupCache.set(key, pending);
      if (lookupCache.size > MAX_CACHED_LOOKUPS) {
        lookupCache.delete(lookupCache.keys().next().value);
      }
    }
    return pending;
  }

  async function runLookup(query) {
    if (query.isWord) {
      const definition = await fetchDefinition(query.text);
      if (definition.hasResult) {
        return { type: "definition", word: query.text, ...definition };
      }
    }
    // Words the dictionary doesn't know are often names, which Wikipedia usually has.
    const summary = await fetchWikipediaSummary(query.text);
    return summary ? { type: "wikipedia", ...summary } : null;
  }

  function renderMessage(root, heading, message) {
    if (!root.isConnected) {
      return;
    }
    const doc = root.ownerDocument;
    root.replaceChildren(
      createTextElement(doc, "zvh-reader-word", heading),
      createTextElement(doc, "zvh-reader-meaning", message)
    );
  }

  function renderResult(root, query, result) {
    if (!root.isConnected) {
      return;
    }
    if (!result) {
      renderMessage(
        root,
        query.text,
        query.isWord ? "No definition or Wikipedia article found." : "No Wikipedia article found."
      );
      return;
    }

    const doc = root.ownerDocument;
    if (result.type === "definition") {
      const meaning = createTextElement(doc, "zvh-reader-meaning", "");
      for (const section of result.sections.slice(0, 2)) {
        const pos = section.partOfSpeech ? `[${section.partOfSpeech}] ` : "";
        meaning.appendChild(createTextElement(doc, "zvh-reader-definition", `${pos}${section.definition}`));
      }
      root.replaceChildren(
        createTextElement(doc, "zvh-reader-word", result.word),
        createTextElement(doc, "zvh-reader-phonetic", result.phonetic ? `/${result.phonetic}/` : ""),
        meaning
      );
      return;
    }

    const children = [];
    if (result.isSearchMatch) {
      children.push(createTextElement(doc, "zvh-reader-note", "Closest Wikipedia match:"));
    }
    children.push(
      createTextElement(doc, "zvh-reader-word", result.title),
      createTextElement(doc, "zvh-reader-meaning", result.extract)
    );
    root.replaceChildren(...children);
    if (result.url) {
      const link = doc.createElement("a");
      link.className = "zvh-reader-link";
      link.href = result.url;
      link.textContent = "Read more on Wikipedia";
      link.addEventListener("click", (event) => {
        // The reader blocks web navigation, so open the article in the system browser.
        event.preventDefault();
        event.stopPropagation();
        Zotero.launchURL(result.url);
      });
      root.appendChild(link);
    }
  }

  function createTextElement(doc, className, text) {
    const el = doc.createElement("div");
    el.className = className;
    el.textContent = text;
    return el;
  }

  function normalizeInlineText(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function normalizeWord(text) {
    // Keep only plain English-like tokens (letters plus apostrophe/hyphen).
    const cleaned = (text || "").trim().replace(/[“”"'`]/g, "");
    if (!cleaned || cleaned.length > 64) {
      return null;
    }
    if (!/^[A-Za-z][A-Za-z'-]*$/.test(cleaned)) {
      return null;
    }
    return cleaned;
  }

  function truncateText(text, maxLength) {
    if (text.length <= maxLength) {
      return text;
    }
    // Prefer ending on a full sentence; otherwise cut at a word boundary.
    const cut = text.slice(0, maxLength);
    const sentenceEnd = cut.lastIndexOf(". ");
    if (sentenceEnd > maxLength / 2) {
      return cut.slice(0, sentenceEnd + 1);
    }
    return `${cut.slice(0, cut.lastIndexOf(" "))}…`;
  }

  async function fetchDefinition(word) {
    const endpoint = `https://lumetrium.com/dictionary-api/v1/entries/en/${encodeURIComponent(word)}`;
    const noResult = { hasResult: false, phonetic: "", sections: [] };

    try {
      const response = await doRequest(endpoint);
      if (!response.ok) {
        return noResult;
      }

      const data = await response.json();
      if (!Array.isArray(data) || data.length === 0) {
        return noResult;
      }

      const entry = data[0] || {};
      const phonetic = entry.phonetic || "";
      const meaning = entry.meaning || {};

      const sections = [];
      for (const partOfSpeech of Object.keys(meaning)) {
        const definitions = Array.isArray(meaning[partOfSpeech]?.definitions)
          ? meaning[partOfSpeech].definitions
          : [];

        for (const defObj of definitions) {
          const definition = (defObj?.definition || "").trim();
          if (definition) {
            sections.push({ partOfSpeech, definition });
          }
        }
      }

      return {
        hasResult: sections.length > 0,
        phonetic,
        sections,
      };
    } catch (err) {
      logDebug("fetchDefinition failed", err);
      return noResult;
    }
  }

  async function fetchWikipediaSummary(text) {
    // Try the selection as an exact article title first (redirects cover most case and plural
    // variants), then fall back to the top search result.
    let summary = await fetchWikipediaPage(text);
    if (!summary || summary.isDisambiguation) {
      const title = await searchWikipediaTitle(text);
      if (title && title !== summary?.title) {
        const match = await fetchWikipediaPage(title);
        if (match) {
          // Search can land on a related topic, so the popup labels it as the closest match.
          summary = { ...match, isSearchMatch: true };
        }
      }
    }
    return summary;
  }

  async function fetchWikipediaPage(title) {
    const response = await doRequest(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}?redirect=true`,
      { headers: WIKIPEDIA_HEADERS }
    );
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Wikipedia summary request failed: ${response.status}`);
    }

    const data = await response.json();
    const extract = normalizeInlineText(data?.extract);
    if (!extract) {
      return null;
    }
    return {
      title: data.title || title,
      extract: truncateText(extract, WIKIPEDIA_EXTRACT_MAX_LENGTH),
      url: data.content_urls?.desktop?.page || null,
      isDisambiguation: data.type === "disambiguation",
    };
  }

  async function searchWikipediaTitle(text) {
    const params = new URLSearchParams({
      action: "query",
      list: "search",
      srsearch: text,
      srlimit: "1",
      format: "json",
    });
    const response = await doRequest(`https://en.wikipedia.org/w/api.php?${params}`, {
      headers: WIKIPEDIA_HEADERS,
    });
    if (!response.ok) {
      throw new Error(`Wikipedia search request failed: ${response.status}`);
    }

    const data = await response.json();
    return data?.query?.search?.[0]?.title || null;
  }

  function injectStyle(doc) {
    // Colors use the reader's theme variables (--fill-*), which switch with Zotero's light/dark mode.
    const css = `
      .selection-popup .zvh-reader-inline {
        margin-top: 6px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 11px;
      }

      .selection-popup .zvh-reader-word {
        font-weight: 700;
        color: var(--fill-primary);
      }

      .selection-popup .zvh-reader-phonetic,
      .selection-popup .zvh-reader-note {
        font-size: 10px;
        color: var(--fill-secondary);
      }

      .selection-popup .zvh-reader-meaning {
        line-height: 1.35;
        color: var(--fill-primary);
      }

      .selection-popup .zvh-reader-definition + .zvh-reader-definition {
        margin-top: 2px;
      }

      .selection-popup .zvh-reader-link {
        font-size: 10px;
        color: var(--accent-blue);
        text-decoration: none;
        cursor: pointer;
      }

      .selection-popup .zvh-reader-link:hover {
        text-decoration: underline;
      }
    `;

    // Overwrite an existing copy so styles from an updated plugin apply without reopening the PDF.
    let style = doc.getElementById(STYLE_ID);
    if (!style) {
      style = doc.createElement("style");
      style.id = STYLE_ID;
      doc.documentElement.appendChild(style);
    }
    if (style.textContent !== css) {
      style.textContent = css;
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
      successCodes: false,
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
    },
  };
})();
