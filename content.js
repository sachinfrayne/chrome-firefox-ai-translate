// Injected on demand (only after you invoke the extension on a tab).
// It never sees the API key: it sends text to the background script and
// gets translations back.

(() => {
  if (window.__aiTranslateLoaded) return;
  window.__aiTranslateLoaded = true;

  const api = globalThis.browser ?? globalThis.chrome;

  const MAX_BATCH_ITEMS = 40;
  const MAX_BATCH_CHARS = 3500;
  const CONCURRENCY = 4;
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION",
    "CODE", "PRE", "KBD", "SAMP", "SVG", "MATH", "IFRAME", "CANVAS", "VIDEO", "AUDIO",
  ]);

  const originals = new Map(); // Text node -> original nodeValue
  let pageRun = 0; // bumped to cancel an in-flight page translation

  // ---- UI (closed shadow root so page styles and scripts cannot touch it) --

  let host, els;

  function ui() {
    if (host?.isConnected) return els;
    host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;";
    const root = host.attachShadow({ mode: "closed" });
    // Built with DOM calls (no innerHTML) so it also works on pages that
    // enforce Trusted Types.
    const make = (tag, props = {}, children = []) => {
      const el = Object.assign(document.createElement(tag), props);
      el.append(...children);
      return el;
    };
    const style = make("style", {
      textContent: `
        :host { color-scheme: light dark; }
        .panel {
          --bg: #ffffff; --fg: #1c1d21; --muted: #62656e; --line: #dcdee4; --accent: #2457d6; --err: #b3261e;
          box-sizing: border-box; width: min(380px, calc(100vw - 32px));
          max-height: min(70vh, 560px); display: flex; flex-direction: column;
          background: var(--bg); color: var(--fg); border: 1px solid var(--line);
          border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.22);
          font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
        }
        @media (prefers-color-scheme: dark) {
          .panel { --bg: #1f2126; --fg: #eceef2; --muted: #a2a6b1; --line: #3a3d46; --accent: #8fb0ff; --err: #ff8a80; }
        }
        header { display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 12px; border-bottom: 1px solid var(--line); }
        header span { flex: 1; font-size: 12px; font-weight: 600; color: var(--muted); letter-spacing: .02em; }
        .body { padding: 12px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
        .body.err { color: var(--err); }
        .body.muted { color: var(--muted); }
        footer { display: flex; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--line); }
        footer:empty { display: none; }
        button {
          font: inherit; font-size: 12px; color: var(--accent); background: none;
          border: 1px solid var(--line); border-radius: 6px; padding: 3px 10px; cursor: pointer;
        }
        button:hover { border-color: var(--accent); }
        button.x { border: none; font-size: 16px; line-height: 1; padding: 2px 6px; color: var(--muted); }
      `,
    });
    const close = make("button", { className: "x", textContent: "✕" });
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", closeUi);
    els = {
      title: make("span"),
      body: make("div", { className: "body" }),
      footer: make("footer"),
    };
    const panel = make("div", { className: "panel" }, [
      make("header", {}, [els.title, close]),
      els.body,
      els.footer,
    ]);
    panel.setAttribute("role", "status");
    root.append(style, panel);
    document.documentElement.appendChild(host);
    return els;
  }

  function closeUi() {
    host?.remove();
  }

  function show({ title, text, kind = "", buttons = [] }) {
    const e = ui();
    e.title.textContent = title;
    e.body.textContent = text;
    e.body.className = `body ${kind}`;
    e.footer.textContent = "";
    for (const [label, onClick] of buttons) {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", () => onClick(b));
      e.footer.appendChild(b);
    }
  }

  function showError(res) {
    const buttons = [];
    if (["no-key", "bad-key", "bad-model"].includes(res.code)) {
      buttons.push(["Open settings", () => api.runtime.sendMessage({ type: "open-options" })]);
    }
    if (originals.size) buttons.push(["Show original", restorePage]);
    show({ title: "AI Translate", text: res.error || "Translation failed.", kind: "err", buttons });
  }

  async function requestTranslation(texts) {
    try {
      const res = await api.runtime.sendMessage({ type: "translate", texts });
      return res ?? { ok: false, error: "No response from the extension." };
    } catch (e) {
      return { ok: false, error: "The extension was reloaded. Refresh this page and try again." };
    }
  }

  // ---- Selection -----------------------------------------------------------

  async function translateSelection(passedText) {
    const text = (window.getSelection()?.toString() || passedText || "").trim();
    if (!text) {
      show({ title: "AI Translate", text: "Select some text first.", kind: "muted" });
      return;
    }
    show({ title: "AI Translate", text: "Translating…", kind: "muted" });
    const res = await requestTranslation([text]);
    if (!res.ok) return showError(res);
    const translated = res.translations[0];
    show({
      title: `Translation (${res.targetLang})`,
      text: translated,
      buttons: [[
        "Copy",
        async (btn) => {
          try {
            await navigator.clipboard.writeText(translated);
            btn.textContent = "Copied";
          } catch (_) {
            btn.textContent = "Copy failed";
          }
        },
      ]],
    });
  }

  // ---- Whole page ----------------------------------------------------------

  function shouldSkip(node) {
    for (let el = node.parentElement; el; el = el.parentElement) {
      if (el === host) return true;
      if (SKIP_TAGS.has(el.tagName.toUpperCase())) return true;
      if (el.isContentEditable) return true;
      if (el.getAttribute("translate") === "no" || el.classList.contains("notranslate")) return true;
    }
    const parent = node.parentElement;
    if (!parent) return true;
    if (parent.checkVisibility && !parent.checkVisibility()) return true;
    return false;
  }

  function collectTextNodes() {
    const nodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (originals.has(n)) continue; // already translated
      if (!/\p{L}/u.test(n.nodeValue)) continue; // nothing to translate
      if (shouldSkip(n)) continue;
      nodes.push(n);
    }
    // Start with what is on screen or below it, then do the part scrolled past.
    const ahead = [], behind = [];
    for (const n of nodes) {
      (n.parentElement.getBoundingClientRect().bottom >= 0 ? ahead : behind).push(n);
    }
    return [...ahead, ...behind];
  }

  function makeBatches(nodes) {
    const batches = [];
    let current = [], chars = 0;
    for (const node of nodes) {
      const len = node.nodeValue.trim().length;
      if (current.length && (current.length >= MAX_BATCH_ITEMS || chars + len > MAX_BATCH_CHARS)) {
        batches.push(current);
        current = [];
        chars = 0;
      }
      current.push(node);
      chars += len;
    }
    if (current.length) batches.push(current);
    return batches;
  }

  function applyTranslation(node, translated) {
    if (!node.isConnected || !translated) return;
    const original = node.nodeValue;
    const lead = original.match(/^\s*/)[0];
    const trail = original.match(/\s*$/)[0];
    originals.set(node, original);
    node.nodeValue = lead + translated.trim() + trail;
  }

  async function translatePage() {
    if (!document.body) return;
    const run = ++pageRun;
    const nodes = collectTextNodes();
    if (!nodes.length) {
      show({
        title: "AI Translate",
        text: originals.size ? "Everything visible is already translated." : "No translatable text found on this page.",
        kind: "muted",
        buttons: originals.size ? [["Show original", restorePage]] : [],
      });
      return;
    }

    const batches = makeBatches(nodes);
    let done = 0, failure = null, next = 0;
    const progress = () =>
      show({
        title: "AI Translate",
        text: `Translating page… ${Math.round((done / batches.length) * 100)}%`,
        kind: "muted",
        buttons: [["Cancel", () => { pageRun++; finish(true); }]],
      });
    const finish = (cancelled) =>
      show({
        title: "AI Translate",
        text: cancelled ? "Translation cancelled." : "Page translated. Run it again to translate content that loads later.",
        kind: "muted",
        buttons: originals.size ? [["Show original", restorePage]] : [],
      });

    progress();
    const worker = async () => {
      while (next < batches.length && !failure && run === pageRun) {
        const batch = batches[next++];
        const res = await requestTranslation(batch.map((n) => n.nodeValue.trim()));
        if (run !== pageRun) return;
        if (!res.ok) {
          failure = res;
          return;
        }
        batch.forEach((node, i) => applyTranslation(node, res.translations[i]));
        done++;
        if (!failure) progress();
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));

    if (run !== pageRun) return;
    if (failure) return showError(failure);
    finish(false);
  }

  function restorePage() {
    pageRun++;
    for (const [node, original] of originals) {
      if (node.isConnected) node.nodeValue = original;
    }
    originals.clear();
    closeUi();
  }

  // ---- Messages from the background script ---------------------------------

  api.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "translate-selection") translateSelection(msg.text);
    else if (msg?.type === "translate-page") translatePage();
    else if (msg?.type === "restore-page") restorePage();
  });
})();
