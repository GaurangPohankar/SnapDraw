/**
 * SnapDraw – local-only Excalidraw assets.
 *
 * Two jobs, both required before Excalidraw's module bundle initialises:
 *
 * 1. Point Excalidraw at the fonts bundled inside the extension instead of the
 *    public CDN it falls back to by default.
 * 2. Rewrite the CDN fallback candidates Excalidraw always appends to its
 *    @font-face source lists. Without this the browser still *tries* the remote
 *    URL first/next (and the extension CSP blocks it), which both wastes time
 *    and violates the "nothing leaves this device" promise. Rewriting keeps the
 *    fallback functional – it now resolves to the extension's own copy.
 *
 * This is a classic (non-module) script so it is guaranteed to execute before
 * the deferred `type="module"` bundle, which is when Excalidraw reads these
 * globals and constructs its font faces.
 */
(function () {
  var base = "/";

  try {
    if (
      typeof chrome !== "undefined" &&
      chrome.runtime &&
      typeof chrome.runtime.getURL === "function" &&
      chrome.runtime.id
    ) {
      base = chrome.runtime.getURL("");
    }
  } catch (error) {
    base = "/";
  }

  if (typeof base !== "string" || base.length === 0) {
    base = "/";
  }
  if (base.charAt(base.length - 1) !== "/") {
    base += "/";
  }

  window.EXCALIDRAW_ASSET_PATH = base;

  // Matches Excalidraw's published asset URL, e.g.
  // https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/fonts/...
  var cdnAssetPattern = /https?:\/\/[^\s"')]+\/@excalidraw\/excalidraw@[^/]+\/dist\/prod\//g;

  var NativeFontFace = window.FontFace;
  if (typeof NativeFontFace !== "function") {
    return;
  }

  function SnapDrawFontFace(family, source, descriptors) {
    var localSource = source;
    if (typeof source === "string" && source.indexOf("@excalidraw/excalidraw@") !== -1) {
      localSource = source.replace(cdnAssetPattern, base);
    }
    return new NativeFontFace(family, localSource, descriptors);
  }

  SnapDrawFontFace.prototype = NativeFontFace.prototype;
  window.FontFace = SnapDrawFontFace;
})();
