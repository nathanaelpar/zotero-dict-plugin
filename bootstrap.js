/* eslint-disable no-undef */

/*
 * bootstrap.js responsibilities
 * - Integrates addon with Zotero's addon lifecycle (install/startup/shutdown).
 * - Creates execution context and loads the runtime module (vocabulary-helper.js).
 * - Delegates real business logic to `Zotero.VocabularyHelper.hooks`.
 */
function install() {}
function uninstall() {}

async function startup({ id, resourceURI, rootURI }) {
  // Ensure Zotero core services are ready before touching Reader/UI APIs.
  await Zotero.initializationPromise;

  if (!rootURI) {
    rootURI = resourceURI.spec;
  }

  const ctx = {
    rootURI,
    addonID: id,
    Services,
    Components,
    Cc,
    Ci,
    ChromeUtils,
    Zotero,
  };
  // Expose context as globalThis for loaded subscript compatibility.
  ctx._globalThis = ctx;

  // Load main addon logic into the custom context above.
  // Zotero's startup cache keys scripts by URL, which is the same for every version of the addon,
  // so skip it; otherwise an update can keep running the previous version's code.
  Services.scriptloader.loadSubScriptWithOptions(`${rootURI}content/scripts/vocabulary-helper.js`, {
    target: ctx,
    ignoreCache: true,
  });

  if (Zotero.VocabularyHelper?.hooks?.onStartup) {
    await Zotero.VocabularyHelper.hooks.onStartup();
  }
}

async function shutdown(_data, reason) {
  // During app shutdown, Firefox/Zotero tears down globals anyway.
  if (reason === APP_SHUTDOWN) {
    return;
  }

  // Forward cleanup to runtime module.
  await Zotero.VocabularyHelper?.hooks?.onShutdown();
}
