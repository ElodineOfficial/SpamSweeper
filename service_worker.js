/* YT Studio Spam Sweeper — background (MV3 service worker) */

const DEFAULT_SETTINGS = {
  threshold: 5,       // edit-distance (keystrokes) allowed
  scanText: true,     // scan text comments
  scanImages: true,   // scan avatar/profile images
  autoScan: true,     // watch page changes & auto-scan
  autoSelect: true    // automatically tick checkboxes on flagged rows
};

const DEFAULT_BLACKLISTS = {
  texts: [],   // stored normalized
  images: []   // stored as normalized image signatures
};

chrome.runtime.onInstalled.addListener(async () => {
  // Initialize storage if missing
  const current = await chrome.storage.local.get(["settings", "blacklists"]);
  if (!current.settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  if (!current.blacklists) await chrome.storage.local.set({ blacklists: DEFAULT_BLACKLISTS });

  // Context menus for right-click blacklist actions
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "ytspam_add_text",
    title: "Blacklist selected text (YT Spam Sweeper)",
    contexts: ["selection"]
  });
  chrome.contextMenus.create({
    id: "ytspam_add_image",
    title: "Blacklist this image (YT Spam Sweeper)",
    contexts: ["image"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === "ytspam_add_text" && info.selectionText) {
      const added = await addTextToBlacklist(info.selectionText);
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "BLACKLIST_UPDATED", kind: "texts", value: added });
    }
    if (info.menuItemId === "ytspam_add_image" && info.srcUrl) {
      const sig = signatureFromSrc(info.srcUrl);
      await addImageToBlacklist(sig);
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "BLACKLIST_UPDATED", kind: "images", value: sig });
    }
  } catch (e) {
    console.warn("Context menu error:", e);
  }
});

// ---- Messaging API for content.js ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === "GET_STATE") {
      const data = await chrome.storage.local.get(["settings", "blacklists"]);
      sendResponse({
        settings: data.settings || DEFAULT_SETTINGS,
        blacklists: data.blacklists || DEFAULT_BLACKLISTS
      });
      return;
    }
    if (msg?.type === "SET_SETTINGS") {
      const merged = { ...DEFAULT_SETTINGS, ...(msg.settings || {}) };
      await chrome.storage.local.set({ settings: merged });
      sendResponse({ ok: true, settings: merged });
      return;
    }
    if (msg?.type === "ADD_TEXT") {
      const added = await addTextToBlacklist(msg.text || "");
      sendResponse({ ok: true, added });
      return;
    }
    if (msg?.type === "ADD_IMAGE") {
      const sig = signatureFromSrc(msg.src || "");
      await addImageToBlacklist(sig);
      sendResponse({ ok: true, added: sig });
      return;
    }
    if (msg?.type === "REMOVE_TEXT") {
      const removed = await removeTextFromBlacklist(msg.value || "");
      sendResponse({ ok: true, removed });
      return;
    }
    if (msg?.type === "REMOVE_IMAGE") {
      const removed = await removeImageFromBlacklist(msg.value || "");
      sendResponse({ ok: true, removed });
      return;
    }
  })();
  return true; // keep message channel open (async)
});

// ---- Helpers ----
function normalizeText(t) {
  return (t || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[^\p{L}\p{N}\s]/gu, "") // remove punctuation/symbols (Unicode-safe)
    .replace(/\s+/g, " ")
    .trim();
}

async function addTextToBlacklist(raw) {
  const value = normalizeText(raw).slice(0, 2000);
  const { blacklists } = await chrome.storage.local.get(["blacklists"]);
  const texts = new Set((blacklists?.texts || []).map(String));
  if (value) texts.add(value);
  const updated = { ...DEFAULT_BLACKLISTS, ...(blacklists || {}), texts: [...texts] };
  await chrome.storage.local.set({ blacklists: updated });
  return value;
}

async function removeTextFromBlacklist(raw) {
  const value = normalizeText(raw);
  const { blacklists } = await chrome.storage.local.get(["blacklists"]);
  const texts = new Set((blacklists?.texts || []).map(String));
  texts.delete(value);
  const updated = { ...DEFAULT_BLACKLISTS, ...(blacklists || {}), texts: [...texts] };
  await chrome.storage.local.set({ blacklists: updated });
  return value;
}

async function addImageToBlacklist(sig) {
  if (!sig) return null;
  const { blacklists } = await chrome.storage.local.get(["blacklists"]);
  const images = new Set((blacklists?.images || []).map(String));
  images.add(sig);
  const updated = { ...DEFAULT_BLACKLISTS, ...(blacklists || {}), images: [...images] };
  await chrome.storage.local.set({ blacklists: updated });
  return sig;
}

async function removeImageFromBlacklist(sig) {
  if (!sig) return null;
  const { blacklists } = await chrome.storage.local.get(["blacklists"]);
  const images = new Set((blacklists?.images || []).map(String));
  images.delete(sig);
  const updated = { ...DEFAULT_BLACKLISTS, ...(blacklists || {}), images: [...images] };
  await chrome.storage.local.set({ blacklists: updated });
  return sig;
}

function signatureFromSrc(src) {
  // Normalize YouTube avatar URLs to a deterministic signature
  try {
    const u = new URL(src);
    let path = u.pathname;
    // Many YT avatars end with a size/styling suffix embedded in the path (e.g., =s88-c-k-...).
    path = path.replace(/=s\d+-.*$/, "");
    const host = u.hostname.replace(/^www\./, "");
    return `${host}${path}`;
  } catch {
    return (String(src || "").split("?")[0] || "").replace(/=s\d+-.*$/, "");
  }
}
