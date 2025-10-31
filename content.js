/* YT Studio Spam Sweeper — content script */

(() => {
  const STATE = {
    settings: {
      threshold: 5,
      scanText: true,
      scanImages: true,
      autoScan: true,
      autoSelect: true
    },
    blacklists: {
      texts: [],
      images: []
    },
    counters: { flagged: 0, selected: 0 },
    scanning: false
  };

  // ---------- Bootstrap ----------
  init().catch(console.warn);

  async function init() {
    // Pull stored settings + blacklists
    try {
      const data = await chrome.runtime.sendMessage({ type: "GET_STATE" });
      if (data?.settings) Object.assign(STATE.settings, data.settings);
      if (data?.blacklists) Object.assign(STATE.blacklists, data.blacklists);
    } catch (e) {
      console.warn("Spam Sweeper: could not load state from background, using defaults.", e);
    }

    injectStyles();
    buildPanel();

    // Initial scan (once we think comments exist)
    waitForCommentsRoot().then(scanNow);

    // Auto-rescan when page mutates (Studio is SPA-like)
    if (STATE.settings.autoScan) {
      startObserver();
    }

    // Listen for background updates (right-click additions)
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === "BLACKLIST_UPDATED") {
        toast(`Blacklist updated: ${msg.kind}. Rescanning…`);
        reloadState().then(() => {
          renderBlacklistEditor(); // keep UI in sync
          scanNow();
        });
      }
    });
  }

  async function reloadState() {
    try {
      const data = await chrome.runtime.sendMessage({ type: "GET_STATE" });
      if (data?.settings) Object.assign(STATE.settings, data.settings);
      if (data?.blacklists) Object.assign(STATE.blacklists, data.blacklists);
      updatePanelFromState();
    } catch (e) {
      console.warn("Spam Sweeper: reloadState failed", e);
    }
  }

  // ---------- DOM/Selectors ----------
  function waitForCommentsRoot(timeoutMs = 10000) {
    const start = Date.now();
    return new Promise((resolve) => {
      const tryFind = () => {
        const found =
          document.querySelector("ytcp-comments") ||
          document.querySelector("ytcp-threads-list") ||
          document.querySelector("ytcp-comment-thread") ||
          document.querySelector("[page-type='comments']");
        if (found) return resolve(found);
        if (Date.now() - start > timeoutMs) return resolve(document.documentElement);
        requestAnimationFrame(tryFind);
      };
      tryFind();
    });
  }

  function findCommentRows() {
    // Multiple strategies because Studio changes often. We want elements that represent a comment "row".
    const set = new Set();
    qsa("ytcp-comment-thread").forEach((el) => set.add(el));
    qsa("ytcp-comment").forEach((el) => set.add(el));
    qsa("ytcp-translated-comment").forEach((el) => set.add(el));
    // Fallback: anything that looks like a list item with a checkbox
    qsa("[role='listitem']").forEach((el) => {
      if (deepQueryOne(el, "ytcp-checkbox, tp-yt-paper-checkbox, [role='checkbox']")) set.add(el);
    });
    return [...set].filter(isVisible);
  }

  function extractCommentText(row) {
    // Grab the longest meaningful text within the row.
    const candidates = qsa(
      "yt-formatted-string, #content-text, .content-text, [slot='comment'], [slot='comment-body'], .comment-text, p, span",
      row
    );
    let best = "";
    for (const el of candidates) {
      const txt = (el.innerText || "").trim();
      if (!txt) continue;
      // Skip obvious UI labels
      if (/^(reply|like|dislike|heart|translate|filter)/i.test(txt)) continue;
      if (txt.length > best.length) best = txt;
    }
    return best;
  }

  function extractAvatarSignature(row) {
    // Targets common YouTube avatar hosts
    const img =
      row.querySelector("img[src*='yt3.ggpht.com'], img[src*='yt3.googleusercontent.com'], img[src*='ytimg.com'], yt-img-shadow img") ||
      row.querySelector("a[href*='channel'] img");
    if (!img || !img.src) return null;
    return signatureFromSrc(img.currentSrc || img.src);
  }

  function signatureFromSrc(src) {
    try {
      const u = new URL(src, location.origin);
      let path = u.pathname.replace(/=s\d+-.*$/, ""); // drop size/styling suffix if present
      return `${u.hostname.replace(/^www\./, "")}${path}`;
    } catch {
      return (String(src).split("?")[0] || "").replace(/=s\d+-.*$/, "");
    }
  }

  // ---------- Text matching (fuzzy) ----------
  function normalizeText(s) {
    return (s || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isTextBlacklisted(text) {
    const t = normalizeText(text);
    const maxDist = Number(STATE.settings.threshold) || 0;
    for (const p of STATE.blacklists.texts) {
      if (!p) continue;
      // Exact/contains first (fast path)
      if (t.includes(p)) return true;
      // Approximate substring: slide a window of p.length, bounded Levenshtein
      if (approxContains(t, p, maxDist)) return true;
    }
    return false;
  }

  function approxContains(text, pattern, maxDist) {
    const L = pattern.length;
    if (!L) return false;
    if (text.length < L) {
      return boundedLevenshtein(text, pattern, maxDist) <= maxDist;
    }
    if (Math.abs(text.length - L) <= maxDist) {
      if (boundedLevenshtein(text, pattern, maxDist) <= maxDist) return true;
    }
    for (let i = 0; i <= text.length - L; i++) {
      const sub = text.slice(i, i + L);
      if (boundedLevenshtein(sub, pattern, maxDist) <= maxDist) return true;
    }
    return false;
  }

  // Banded DP Levenshtein with early exit
  function boundedLevenshtein(a, b, max) {
    const la = a.length, lb = b.length;
    if (max === 0) return a === b ? 0 : max + 1;
    if (Math.abs(la - lb) > max) return max + 1;

    const INF = max + 1;
    let prev = new Array(lb + 1).fill(0);
    let curr = new Array(lb + 1).fill(0);

    for (let j = 0; j <= lb; j++) prev[j] = j;

    for (let i = 1; i <= la; i++) {
      curr[0] = i;
      const from = Math.max(1, i - max);
      const to = Math.min(lb, i + max);

      // Pre-fill out-of-band with INF
      for (let j = 0; j < from; j++) curr[j] = INF;

      let rowMin = curr[from];

      for (let j = from; j <= to; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        const del = prev[j] + 1;
        const ins = curr[j - 1] + 1;
        const sub = prev[j - 1] + cost;
        const val = Math.min(del, ins, sub);
        curr[j] = val;
        if (val < rowMin) rowMin = val;
      }

      for (let j = to + 1; j <= lb; j++) curr[j] = INF;

      if (rowMin > max) return INF; // early exit
      [prev, curr] = [curr, prev]; // swap rows
    }
    return prev[lb];
  }

  // ---------- Deep query utilities (open shadow DOM aware) ----------
  function deepQueryAll(root, selector, maxDepth = 3) {
    const out = [];
    const stack = [[root, 0]];
    while (stack.length) {
      const [node, depth] = stack.pop();
      if (node instanceof Element || node instanceof Document || node instanceof DocumentFragment) {
        try {
          node.querySelectorAll && node.querySelectorAll(selector).forEach((el) => out.push(el));
        } catch {}
        // explore children
        if (depth < maxDepth) {
          const children = node.children || node.childNodes || [];
          for (const c of children) stack.push([c, depth + 1]);
          // open shadow roots
          if (node.shadowRoot) stack.push([node.shadowRoot, depth + 1]);
        }
      }
    }
    return out;
  }
  function deepQueryOne(root, selector, maxDepth = 3) {
    const all = deepQueryAll(root, selector, maxDepth);
    return all.length ? all[0] : null;
  }

  // ---------- Scanning + selection ----------
  async function scanNow() {
    if (STATE.scanning) return;
    STATE.scanning = true;

    const rows = findCommentRows();
    let flagged = 0, selected = 0;

    for (const row of rows) {
      // Reset any prior flag
      row.classList.remove("ytspam-flagged");
      const oldTag = row.querySelector(":scope > .ytspam-tag");
      if (oldTag) oldTag.remove();

      let hit = false;
      const reasons = [];

      if (STATE.settings.scanText) {
        const text = extractCommentText(row);
        if (text && isTextBlacklisted(text)) {
          hit = true;
          reasons.push("text");
        }
      }

      if (STATE.settings.scanImages) {
        const sig = extractAvatarSignature(row);
        if (sig && STATE.blacklists.images.includes(sig)) {
          hit = true;
          reasons.push("image");
        }
      }

      if (hit) {
        flagged++;
        markRow(row, reasons);
        if (STATE.settings.autoSelect) {
          const ok = await selectRowCheckbox(row, true);
          if (ok) selected++;
        }
      }
    }

    STATE.counters.flagged = flagged;
    STATE.counters.selected = selected;
    updateCounters();

    STATE.scanning = false;
  }

  function markRow(row, reasons) {
    row.classList.add("ytspam-flagged");
    if (!row.querySelector(":scope > .ytspam-tag")) {
      const tag = document.createElement("div");
      tag.className = "ytspam-tag";
      tag.textContent = `Spam Sweeper: ${reasons.join(" + ")}`;
      row.appendChild(tag);
    }
  }

  // Robust selection: find multiple candidates, scroll into view, try clicks + property set + keyboard fallback
  async function selectRowCheckbox(row, desired = true) {
    const candidates = getCheckboxCandidates(row);
    if (candidates.length === 0) return false;

    // Helper: read current state from the best host element
    const read = (host) => {
      if (!host) return null;
      if (host.getAttribute?.("aria-checked") === "true") return true;
      if (host.getAttribute?.("aria-checked") === "false") return false;
      if ("checked" in host) return !!host.checked;
      if (host.hasAttribute?.("checked")) return true;
      if (host.classList?.contains("checked")) return true;
      return null;
    };

    // Try each candidate host and its possible internal click targets
    for (const host of candidates) {
      // Already in desired state?
      const before = read(host);
      if (before === desired) return true;

      // Build clickable targets
      const targets = dedupe([
        host,
        host.shadowRoot?.querySelector?.("#checkbox"),
        host.shadowRoot?.querySelector?.("[role='checkbox']"),
        host.shadowRoot?.querySelector?.("input[type='checkbox']"),
        host.querySelector?.("[role='checkbox']"),
        host.querySelector?.("input[type='checkbox']")
      ].filter(Boolean));

      // 1) Scroll and click attempts
      for (const t of targets) {
        try {
          host.scrollIntoView?.({ block: "center", inline: "center", behavior: "instant" });
          await sleep(30);
          t.click?.();
          await sleep(50);
          const afterClick = read(host);
          if (afterClick === desired) return true;
        } catch {}
      }

      // 2) Property set + events (works on many custom checkboxes)
      try {
        if ("checked" in host) {
          host.checked = desired;
          host.dispatchEvent?.(new Event("input", { bubbles: true }));
          host.dispatchEvent?.(new Event("change", { bubbles: true }));
          await sleep(40);
          if (read(host) === desired) return true;
        }
      } catch {}

      // 3) Try inner input if present (in open shadow roots)
      try {
        const inner = host.shadowRoot?.querySelector?.("input[type='checkbox']");
        if (inner) {
          inner.checked = desired;
          inner.dispatchEvent(new Event("input", { bubbles: true }));
          inner.dispatchEvent(new Event("change", { bubbles: true }));
          await sleep(40);
          if (read(host) === desired) return true;
        }
      } catch {}

      // 4) aria-checked fallback
      try {
        host.setAttribute?.("aria-checked", desired ? "true" : "false");
        host.dispatchEvent?.(new Event("change", { bubbles: true }));
        await sleep(30);
        if (read(host) === desired) return true;
      } catch {}

      // 5) “Select” button/label on the row if present
      const rowSelect = deepQueryOne(row, "[aria-label*='Select'], button[aria-label*='Select']");
      if (rowSelect) {
        try {
          row.scrollIntoView?.({ block: "center", inline: "center", behavior: "instant" });
          await sleep(25);
          rowSelect.click?.();
          await sleep(50);
          if (read(host) === desired) return true;
        } catch {}
      }

      // 6) Keyboard fallback (space toggles many checkboxes)
      try {
        host.focus?.();
        await sleep(10);
        host.dispatchEvent?.(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true }));
        host.dispatchEvent?.(new KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true }));
        await sleep(50);
        if (read(host) === desired) return true;
      } catch {}
    }

    return false;
  }

  function getCheckboxCandidates(row) {
    const scope = row.closest("ytcp-comment-thread") || row;
    // Gather several likely hosts within the row (with deep search for open shadow DOMs)
    const els = dedupe([
      ...deepQueryAll(scope, "ytcp-checkbox"),
      ...deepQueryAll(scope, "tp-yt-paper-checkbox"),
      ...deepQueryAll(scope, "[role='checkbox']"),
      ...deepQueryAll(scope, "input[type='checkbox']")
    ]).filter(isVisible);
    // Prefer element types that are known to be the actual checkbox hosts
    const score = (el) => {
      const tag = el.tagName || "";
      if (/YTCP-CHECKBOX/.test(tag)) return 3;
      if (/TP-YT-PAPER-CHECKBOX/.test(tag)) return 3;
      if (el.getAttribute && el.getAttribute("role") === "checkbox") return 2;
      if (el.matches && el.matches("input[type='checkbox']")) return 1;
      return 0;
    };
    return els.sort((a, b) => score(b) - score(a));
  }

  // ---------- Observer ----------
  let observer = null;
  function startObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(debounce(() => scanNow(), 600));
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ---------- Panel/UI ----------
  let panel,
    flaggedCountEl,
    selectedCountEl,
    thresholdInput,
    scanTextChk,
    scanImageChk,
    autoScanChk,
    autoSelectChk,
    manageBtn,
    blContainer;

  function injectStyles() {
    const css = `
      .ytspam-panel {
        position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
        background: #0f0f0f; color: #fff; font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; padding: 12px 12px 10px; box-shadow: 0 8px 24px rgba(0,0,0,.35);
        width: 300px;
      }
      .ytspam-panel h3 { margin: 0 0 8px; font-size: 13px; letter-spacing: .2px; }
      .ytspam-row { display: flex; align-items: center; justify-content: space-between; margin: 6px 0; gap: 8px; }
      .ytspam-row label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
      .ytspam-row input[type="number"] { width: 64px; padding: 4px; border-radius: 6px; border: 1px solid #333; background: #1a1a1a; color: #fff; }
      .ytspam-btn {
        border: 1px solid #444; background: #1e1e1e; color: #fff; padding: 6px 10px; border-radius: 8px; cursor: pointer;
      }
      .ytspam-btn:hover { background: #262626; }
      .ytspam-btn.primary { border-color: #3f83f8; }
      .ytspam-stats { font-size: 12px; opacity: 0.9; }
      .ytspam-tag {
        display: inline-block; margin-top: 6px; background: #ffbf00; color: #111;
        padding: 2px 6px; border-radius: 6px; font-weight: 600; font-size: 11px; width: fit-content;
      }
      .ytspam-flagged { outline: 2px solid #ffbf00; outline-offset: 2px; border-radius: 6px; }
      .ytspam-toast {
        position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
        background: #111; color: #fff; border: 1px solid #333; padding: 10px 14px; border-radius: 10px; z-index: 2147483647;
        opacity: 0; transition: opacity .15s ease;
      }
      .ytspam-toast.show { opacity: 1; }
      .ytspam-row .group { display: flex; gap: 6px; }

      /* Blacklist Manager */
      .ytspam-bl { margin-top: 8px; border-top: 1px solid #2a2a2a; padding-top: 8px; display: none; }
      .ytspam-bl.open { display: block; }
      .ytspam-section { margin: 8px 0 6px; }
      .ytspam-section h4 { margin: 6px 0; font-size: 12px; opacity: .9; font-weight: 700; }
      .ytspam-list { max-height: 140px; overflow: auto; border: 1px solid #2a2a2a; border-radius: 8px; padding: 6px; background: #141414; }
      .ytspam-list ul { list-style: none; margin: 0; padding: 0; }
      .ytspam-list li { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 4px 0; border-bottom: 1px dotted #2a2a2a; }
      .ytspam-list li:last-child { border-bottom: none; }
      .ytspam-x { background: #272727; border: 1px solid #3a3a3a; border-radius: 6px; padding: 2px 6px; cursor: pointer; }
      .ytspam-x:hover { background: #333; }
      .ytspam-addrow { display: flex; gap: 6px; margin-top: 6px; }
      .ytspam-addrow input[type="text"] { flex: 1; padding: 6px; border-radius: 8px; border: 1px solid #333; background: #1a1a1a; color: #fff; }
      .ytspam-imggrid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }
      .ytspam-imgcell { position: relative; border: 1px solid #2a2a2a; border-radius: 8px; overflow: hidden; background: #0c0c0c; height: 52px; display: flex; align-items: center; justify-content: center; }
      .ytspam-imgcell img { width: 100%; height: 100%; object-fit: cover; }
      .ytspam-imgcell button { position: absolute; top: 4px; right: 4px; }
    `;
    const style = document.createElement("style");
    style.textContent = css;
    document.documentElement.appendChild(style);
  }

  function buildPanel() {
    panel = document.createElement("div");
    panel.className = "ytspam-panel";
    panel.innerHTML = `
      <h3>Spam Sweeper</h3>

      <div class="ytspam-row">
        <button class="ytspam-btn primary" id="ytspam-scan">Scan Now</button>
        <div class="ytspam-stats">Flagged: <b id="ytspam-flagged">0</b> · Selected: <b id="ytspam-selected">0</b></div>
      </div>

      <div class="ytspam-row">
        <label><input type="checkbox" id="ytspam-scantext"> Scan text</label>
        <label><input type="checkbox" id="ytspam-scanimages"> Scan images</label>
      </div>

      <div class="ytspam-row">
        <label>Threshold <input type="number" id="ytspam-threshold" min="0" max="20" step="1"></label>
        <label><input type="checkbox" id="ytspam-autoselect"> Auto-select</label>
      </div>

      <div class="ytspam-row">
        <label><input type="checkbox" id="ytspam-autoscan"> Auto-scan</label>
        <div class="group">
          <button class="ytspam-btn" id="ytspam-select-flagged">Select Flagged</button>
          <button class="ytspam-btn" id="ytspam-unselect-flagged">Unselect</button>
        </div>
      </div>

      <div class="ytspam-row">
        <button class="ytspam-btn" id="ytspam-manage">Manage Blacklist</button>
      </div>

      <div class="ytspam-bl" id="ytspam-bl">
        <div class="ytspam-section">
          <h4>Blacklisted Text (${STATE.blacklists.texts.length})</h4>
          <div class="ytspam-list">
            <ul id="ytspam-bl-texts"></ul>
          </div>
          <div class="ytspam-addrow">
            <input type="text" id="ytspam-add-text" placeholder="Add text…">
            <button class="ytspam-btn" id="ytspam-add-text-btn">Add</button>
          </div>
        </div>

        <div class="ytspam-section">
          <h4>Blacklisted Profile Pictures (${STATE.blacklists.images.length})</h4>
          <div class="ytspam-list">
            <div id="ytspam-bl-images" class="ytspam-imggrid"></div>
          </div>
          <div class="ytspam-addrow">
            <input type="text" id="ytspam-add-image" placeholder="Paste avatar/image URL…">
            <button class="ytspam-btn" id="ytspam-add-image-btn">Add</button>
          </div>
        </div>
      </div>
    `;
    document.documentElement.appendChild(panel);

    flaggedCountEl = panel.querySelector("#ytspam-flagged");
    selectedCountEl = panel.querySelector("#ytspam-selected");
    thresholdInput = panel.querySelector("#ytspam-threshold");
    scanTextChk = panel.querySelector("#ytspam-scantext");
    scanImageChk = panel.querySelector("#ytspam-scanimages");
    autoScanChk = panel.querySelector("#ytspam-autoscan");
    autoSelectChk = panel.querySelector("#ytspam-autoselect");
    manageBtn = panel.querySelector("#ytspam-manage");
    blContainer = panel.querySelector("#ytspam-bl");

    // Set initial states
    updatePanelFromState();
    renderBlacklistEditor();

    // Wire controls
    panel.querySelector("#ytspam-scan").addEventListener("click", scanNow);
    panel.querySelector("#ytspam-select-flagged").addEventListener("click", async () => {
      const n = await bulkSelectFlagged(true);
      toast(`Selected ${n} flagged`);
      STATE.counters.selected = n;
      updateCounters();
    });
    panel.querySelector("#ytspam-unselect-flagged").addEventListener("click", async () => {
      const n = await bulkSelectFlagged(false);
      toast(`Unselected ${n} flagged`);
      STATE.counters.selected = 0;
      updateCounters();
    });

    thresholdInput.addEventListener("change", persistSettings);
    scanTextChk.addEventListener("change", persistSettings);
    scanImageChk.addEventListener("change", persistSettings);
    autoScanChk.addEventListener("change", () => {
      persistSettings();
      if (autoScanChk.checked) startObserver();
      else if (observer) observer.disconnect();
    });
    autoSelectChk.addEventListener("change", persistSettings);

    manageBtn.addEventListener("click", () => {
      blContainer.classList.toggle("open");
      renderBlacklistEditor();
    });

    // Add text/image
    panel.querySelector("#ytspam-add-text-btn").addEventListener("click", async () => {
      const input = panel.querySelector("#ytspam-add-text");
      const raw = (input.value || "").trim();
      if (!raw) return;
      await chrome.runtime.sendMessage({ type: "ADD_TEXT", text: raw });
      input.value = "";
      await reloadState();
      renderBlacklistEditor();
      toast("Added text to blacklist");
    });
    panel.querySelector("#ytspam-add-image-btn").addEventListener("click", async () => {
      const input = panel.querySelector("#ytspam-add-image");
      const raw = (input.value || "").trim();
      if (!raw) return;
      await chrome.runtime.sendMessage({ type: "ADD_IMAGE", src: raw });
      input.value = "";
      await reloadState();
      renderBlacklistEditor();
      toast("Added image to blacklist");
    });
  }

  function renderBlacklistEditor() {
    if (!blContainer) return;
    // Texts
    const ul = blContainer.querySelector("#ytspam-bl-texts");
    ul.innerHTML = "";
    STATE.blacklists.texts.forEach((t) => {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.textContent = t;
      const btn = document.createElement("button");
      btn.className = "ytspam-x";
      btn.textContent = "Remove";
      btn.addEventListener("click", async () => {
        await chrome.runtime.sendMessage({ type: "REMOVE_TEXT", value: t });
        await reloadState();
        renderBlacklistEditor();
      });
      li.appendChild(span);
      li.appendChild(btn);
      ul.appendChild(li);
    });

    // Images
    const grid = blContainer.querySelector("#ytspam-bl-images");
    grid.innerHTML = "";
    STATE.blacklists.images.forEach((sig) => {
      const cell = document.createElement("div");
      cell.className = "ytspam-imgcell";
      const img = document.createElement("img");
      img.alt = sig;
      img.referrerPolicy = "no-referrer";
      // Reconstruct a preview URL: signature is host+path without size; append a common size suffix.
      const url = guessAvatarPreviewUrl(sig);
      img.src = url;
      const btn = document.createElement("button");
      btn.className = "ytspam-x";
      btn.textContent = "×";
      btn.title = "Remove";
      btn.addEventListener("click", async () => {
        await chrome.runtime.sendMessage({ type: "REMOVE_IMAGE", value: sig });
        await reloadState();
        renderBlacklistEditor();
      });
      cell.appendChild(img);
      cell.appendChild(btn);
      grid.appendChild(cell);
    });

    // Update section headers with counts
    const h4s = blContainer.querySelectorAll(".ytspam-section h4");
    if (h4s[0]) h4s[0].innerHTML = `Blacklisted Text (${STATE.blacklists.texts.length})`;
    if (h4s[1]) h4s[1].innerHTML = `Blacklisted Profile Pictures (${STATE.blacklists.images.length})`;
  }

  function guessAvatarPreviewUrl(signature) {
    // signature looks like "yt3.ggpht.com/SomeLongPath"
    // Most avatars accept a size suffix like "=s64-c-k-c0x00ffffff-no-rj"
    const hasProtocol = /^https?:\/\//i.test(signature);
    const base = hasProtocol ? signature : `https://${signature}`;
    if (/=s\d+-/.test(base)) return base; // already has size
    return `${base}=s64-c-k-c0x00ffffff-no-rj`;
  }

  function updatePanelFromState() {
    thresholdInput.value = STATE.settings.threshold;
    scanTextChk.checked = !!STATE.settings.scanText;
    scanImageChk.checked = !!STATE.settings.scanImages;
    autoScanChk.checked = !!STATE.settings.autoScan;
    autoSelectChk.checked = !!STATE.settings.autoSelect;
    updateCounters();
  }

  function updateCounters() {
    if (flaggedCountEl) flaggedCountEl.textContent = String(STATE.counters.flagged || 0);
    if (selectedCountEl) selectedCountEl.textContent = String(STATE.counters.selected || 0);
  }

  async function bulkSelectFlagged(desired) {
    const items = qsa(".ytspam-flagged");
    let n = 0;
    for (const row of items) {
      const ok = await selectRowCheckbox(row, desired);
      if (ok) n++;
    }
    return n;
  }

  function persistSettings() {
    STATE.settings.threshold = Number(thresholdInput.value || 0);
    STATE.settings.scanText = !!scanTextChk.checked;
    STATE.settings.scanImages = !!scanImageChk.checked;
    STATE.settings.autoScan = !!autoScanChk.checked;
    STATE.settings.autoSelect = !!autoSelectChk.checked;
    chrome.runtime.sendMessage({ type: "SET_SETTINGS", settings: STATE.settings }).catch(() => {});
  }

  // ---------- Utilities ----------
  function qsa(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  }
  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect?.();
    if (!rect) return !!(el.offsetParent !== null);
    return rect.width > 0 && rect.height > 0;
  }
  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(null, args), ms);
    };
  }
  function dedupe(arr) {
    const set = new Set();
    const out = [];
    for (const a of arr) {
      if (!a) continue;
      if (!set.has(a)) { set.add(a); out.push(a); }
    }
    return out;
  }
  function sleep(ms) {
    return new Promise((res) => setTimeout(res, ms));
  }
  function toast(msg, ms = 1400) {
    const t = document.createElement("div");
    t.className = "ytspam-toast";
    t.textContent = msg;
    document.documentElement.appendChild(t);
    requestAnimationFrame(() => t.classList.add("show"));
    setTimeout(() => {
      t.classList.remove("show");
      setTimeout(() => t.remove(), 200);
    }, ms);
  }
})();
