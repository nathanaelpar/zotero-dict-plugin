/* eslint-disable no-undef */

var chromeHandle;

function install() {}
function uninstall() {}

async function startup({ id, resourceURI, rootURI }) {
  await Zotero.initializationPromise;

  if (!rootURI) {
    rootURI = resourceURI.spec;
  }

  var aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
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
  ctx._globalThis = ctx;

  Services.scriptloader.loadSubScript(
    `${rootURI}/content/scripts/vocabulary-helper.js`,
    ctx
  );

  if (Zotero.VocabularyHelper?.hooks?.onStartup) {
    await Zotero.VocabularyHelper.hooks.onStartup();
  }
}

async function shutdown(_data, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }

  await Zotero.VocabularyHelper?.hooks?.onShutdown();

  Cc["@mozilla.org/intl/stringbundle;1"]
    .getService(Components.interfaces.nsIStringBundleService)
    .flushBundles();

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}
