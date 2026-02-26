/* eslint-disable no-undef */

/*
 * bootstrap.js responsibilities
 * - Integrates addon with Zotero's addon lifecycle (install/startup/shutdown).
 * - Registers chrome resources so /content files can be loaded.
 * - Creates execution context and loads the runtime module (vocabulary-helper.js).
 * - Delegates real business logic to `Zotero.VocabularyHelper.hooks`.
 */
var chromeHandle;

function install() {}
function uninstall() {}

async function startup({ id, resourceURI, rootURI }) {
  // Ensure Zotero core services are ready before touching Reader/UI APIs.
  await Zotero.initializationPromise;

  if (!rootURI) {
    rootURI = resourceURI.spec;
  }

  var aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  // Register addon "content" path so files under /content are loadable by Zotero chrome URLs.
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "zoterovocabularyhelper", rootURI + "content/"],
  ]);

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
  Services.scriptloader.loadSubScript(
    `${rootURI}/content/scripts/vocabulary-helper.js`,
    ctx
  );

  if (Zotero.VocabularyHelper?.hooks?.onStartup) {
    await Zotero.VocabularyHelper.hooks.onStartup();
  }
}

async function shutdown(_data, reason) {
  // During app shutdown, Firefox/Zotero tears down globals anyway.
  if (reason === APP_SHUTDOWN) {
    return;
  }

  // Forward cleanup to runtime module first, then release bootstrap-level resources.
  await Zotero.VocabularyHelper?.hooks?.onShutdown();

  // Drop localized string caches so reloading addon does not keep stale bundles.
  Cc["@mozilla.org/intl/stringbundle;1"]
    .getService(Components.interfaces.nsIStringBundleService)
    .flushBundles();

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}
