// Injected on demand (only after you invoke the extension on a tab).
// It never sees the API key: it sends text to the background script and
// gets translations back.

(() => {
  if (window.__aiTranslateLoaded) return;
  window.__aiTranslateLoaded = true;

  const api = globalThis.browser ?? globalThis.chrome;

  const MAX_BATCH_ITEMS = 40;
  const MAX_BATCH_CHARS = 3500;
  const MAX_BLOCK_CHARS = 20000;
  const CONCURRENCY = 4;
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION",
    "CODE", "PRE", "KBD", "SAMP", "SVG", "MATH", "IFRAME", "CANVAS", "VIDEO", "AUDIO",
  ]);

  const originals = new Map(); // Text node -> original nodeValue
  let pageRun = 0; // bumped to cancel an in-flight page translation

  // ---- UI (closed shadow root so page styles and scripts cannot touch it) --

  let host, els;

  // The UI is built with DOM calls (no innerHTML) so it also works on pages
  // that enforce Trusted Types.
  const make = (tag, props = {}, children = []) => {
    const el = Object.assign(document.createElement(tag), props);
    el.append(...children);
    return el;
  };

  function ui() {
    if (host?.isConnected) return els;
    host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
    // Keep typing in our panel from reaching the page's own keyboard handlers.
    for (const type of ["keydown", "keyup", "keypress", "beforeinput", "input", "paste", "copy", "cut"]) {
      host.addEventListener(type, (e) => e.stopPropagation());
    }
    const root = host.attachShadow({ mode: "closed" });
    const style = make("style", {
      textContent: `
        :host { color-scheme: light dark; }
        .panel, .pick {
          --bg: #ffffff; --fg: #1c1d21; --muted: #62656e; --line: #dcdee4; --field: #f6f7f9; --accent: #2457d6; --err: #b3261e;
        }
        @media (prefers-color-scheme: dark) {
          .panel, .pick { --bg: #1f2126; --fg: #eceef2; --muted: #a2a6b1; --line: #3a3d46; --field: #2a2d34; --accent: #8fb0ff; --err: #ff8a80; }
        }
        textarea, select {
          box-sizing: border-box; font: inherit; color: var(--fg); background: var(--field);
          border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px;
        }
        textarea { display: block; width: 100%; min-height: 84px; resize: vertical; }
        textarea:focus-visible, select:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
        .meta { color: var(--muted); font-size: 12px; margin-top: 8px; }
        .ctx { display: flex; gap: 8px; align-items: baseline; margin: 0 0 8px; }
        .ctx span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .row { display: flex; align-items: center; gap: 8px; margin-top: 8px; color: var(--muted); font-size: 12px; }
        .row select { font-size: 12px; padding: 3px 6px; }
        footer button:first-child { background: var(--accent); border-color: var(--accent); color: var(--bg); font-weight: 600; }
        .panel {
          position: fixed; box-sizing: border-box; width: min(380px, calc(100vw - 16px));
          max-height: min(70vh, 560px); display: flex; flex-direction: column;
          background: var(--bg); color: var(--fg); border: 1px solid var(--line);
          border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.22);
          font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
        }
        .panel[hidden], .pick[hidden] { display: none; }
        .pick {
          position: fixed; box-sizing: border-box; pointer-events: none;
          border: 2px solid var(--accent); border-radius: 4px;
          background: color-mix(in srgb, var(--accent) 14%, transparent);
        }
        header { display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 12px; border-bottom: 1px solid var(--line); }
        header span { flex: 1; font-size: 12px; font-weight: 600; color: var(--muted); letter-spacing: .02em; }
        .body { padding: 12px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
        .body.err { color: var(--err); }
        .body.muted { color: var(--muted); }
        footer { display: flex; flex-wrap: wrap; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--line); }
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
      pick: make("div", { className: "pick", hidden: true }),
    };
    els.panel = make("div", { className: "panel" }, [
      make("header", {}, [els.title, close]),
      els.body,
      els.footer,
    ]);
    els.panel.setAttribute("role", "status");
    root.append(style, els.pick, els.panel);
    document.documentElement.appendChild(host);
    return els;
  }

  function closeUi() {
    stopPicking();
    cancelVoice();
    host?.remove();
  }

  // Put the panel next to `anchor` (a DOMRect), below it if there is room and
  // above it otherwise. Without an anchor it sits in the top right corner.
  function placePanel(anchor) {
    const s = els.panel.style;
    s.top = s.bottom = s.left = s.right = "";
    if (!anchor || (!anchor.width && !anchor.height)) {
      s.top = s.right = "16px";
      return;
    }
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const width = Math.min(380, vw - 16);
    s.left = `${Math.max(8, Math.min(anchor.left, vw - width - 8))}px`;
    const below = vh - anchor.bottom, above = anchor.top;
    if (below >= 180 || below >= above) {
      s.top = `${Math.max(8, Math.min(anchor.bottom + 8, vh - 120))}px`;
      s.maxHeight = `${Math.max(120, vh - anchor.bottom - 16)}px`;
    } else {
      s.bottom = `${Math.max(8, vh - anchor.top + 8)}px`;
      s.maxHeight = `${Math.max(120, anchor.top - 16)}px`;
    }
  }

  function show({ title, text = "", kind = "", buttons = [], anchor = null, content = [] }) {
    const e = ui();
    e.panel.style.maxHeight = "";
    placePanel(anchor);
    e.title.textContent = title;
    e.body.textContent = text;
    e.body.append(...content);
    e.body.className = `body ${kind}`;
    e.footer.textContent = "";
    for (const [label, onClick] of buttons) {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", () => onClick(b));
      e.footer.appendChild(b);
    }
  }

  function showError(res, anchor, extraButtons = []) {
    const buttons = [...extraButtons];
    if (["no-key", "bad-key", "bad-model"].includes(res.code)) {
      buttons.push(["Open settings", () => api.runtime.sendMessage({ type: "open-options" })]);
    }
    if (originals.size) buttons.push(["Show original", restorePage]);
    show({ title: "AI Translate", text: res.error || "Translation failed.", kind: "err", buttons, anchor });
  }

  async function send(msg) {
    try {
      const res = await api.runtime.sendMessage(msg);
      return res ?? { ok: false, error: "No response from the extension." };
    } catch (e) {
      return { ok: false, error: "The extension was reloaded. Refresh this page and try again." };
    }
  }

  const requestTranslation = (texts) => send({ type: "translate", texts });

  const copyButton = (text) => [
    "Copy",
    async (btn) => {
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = "Copied";
      } catch (_) {
        btn.textContent = "Copy failed";
      }
    },
  ];

  // ---- One piece of text (selection or picked block) ------------------------

  let lastSource = null; // the last text translated this way, used as reply context

  async function translateText(text, anchor) {
    show({ title: "AI Translate", text: "Translating…", kind: "muted", anchor });
    const res = await requestTranslation([text]);
    if (!res.ok) return showError(res, anchor);
    lastSource = text;
    const translated = res.translations[0];
    show({
      title: `Translation (${res.targetLang})`,
      text: translated,
      anchor,
      buttons: [["Reply", () => startCompose(anchor)], copyButton(translated)],
    });
  }

  // ---- Write a reply in another language -------------------------------------

  const TONES = [["casual", "Casual"], ["neutral", "Neutral"], ["formal", "Formal"]];
  let replyTarget = null; // the page's message box, where "Insert" puts the reply
  let draft = "";
  let prefs = null; // { replyLang, replyTone }

  const isEditable = (el) =>
    !!el && el !== host &&
    (el.isContentEditable || el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && ["text", "search"].includes(el.type)));

  window.addEventListener("focusin", (e) => {
    if (isEditable(e.target)) replyTarget = e.target;
  }, true);

  async function startCompose(anchor = null) {
    stopPicking();
    if (isEditable(document.activeElement)) replyTarget = document.activeElement;
    const res = await send({ type: "prefs" });
    if (!res.ok) return showError(res, anchor);
    prefs = { replyLang: res.replyLang, replyTone: res.replyTone };

    const input = make("textarea", { value: draft, placeholder: "Write your reply in any language" });
    const toneSelect = make("select", {}, TONES.map(([value, textContent]) => make("option", { value, textContent })));
    toneSelect.value = prefs.replyTone;
    toneSelect.setAttribute("aria-label", "Tone");
    const content = [input, make("div", { className: "row" }, ["Tone", toneSelect])];
    if (lastSource) {
      const forget = make("button", { textContent: "Ignore" });
      const ctx = make("div", { className: "meta ctx" }, [
        make("span", { textContent: `Replying to: ${lastSource.replace(/\s+/g, " ")}` }),
        forget,
      ]);
      forget.addEventListener("click", () => {
        lastSource = null;
        ctx.remove();
        input.focus();
      });
      content.unshift(ctx);
    }

    const submit = () => {
      draft = input.value.trim();
      prefs.replyTone = toneSelect.value;
      if (draft) writeReply(anchor);
      else input.focus();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        draft = input.value;
        closeUi();
      }
    });

    show({ title: `Reply in ${prefs.replyLang}`, content, anchor, buttons: [["Translate", submit]] });
    input.focus();
  }

  async function writeReply(anchor) {
    const edit = ["Edit", () => startCompose(anchor)];
    show({ title: `Reply in ${prefs.replyLang}`, text: "Writing…", kind: "muted", anchor });
    const res = await send({ type: "compose", text: draft, context: lastSource, tone: prefs.replyTone });
    if (!res.ok) return showError(res, anchor, [edit]);
    show({
      title: `Reply (${res.replyLang})`,
      text: res.reply,
      content: res.meaning ? [make("div", { className: "meta", textContent: `Means: ${res.meaning}` })] : [],
      anchor,
      buttons: [["Insert", (btn) => insertReply(res.reply, btn)], copyButton(res.reply), edit, ["Try again", () => writeReply(anchor)]],
    });
  }

  // Types the reply into the page's message box. It never sends the message.
  function insertReply(text, btn) {
    const el = replyTarget?.isConnected ? replyTarget : null;
    if (!el) {
      btn.textContent = "Click the message box, then Insert";
      return;
    }
    el.focus();
    let done = false;
    try {
      done = document.execCommand("insertText", false, text);
    } catch (_) {}
    if (!done && el.isContentEditable) {
      // Editors that ignore execCommand usually accept a paste.
      const data = new DataTransfer();
      data.setData("text/plain", text);
      done = !el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    } else if (!done) {
      el.setRangeText(text, el.selectionStart, el.selectionEnd, "end");
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      done = true;
    }
    if (done) draft = "";
    btn.textContent = done ? "Inserted" : "Could not insert, use Copy";
  }

  function translateSelection(passedText) {
    stopPicking();
    const sel = window.getSelection();
    const text = (sel?.toString() || passedText || "").trim();
    if (!text) {
      show({ title: "AI Translate", text: "Select some text first.", kind: "muted" });
      return;
    }
    const anchor = sel?.rangeCount && sel.toString() ? sel.getRangeAt(0).getBoundingClientRect() : null;
    translateText(text, anchor);
  }

  // ---- Voice messages ---------------------------------------------------------
  // The background script injects a small helper into the page that waits for
  // the next audio the page plays and posts its bytes back to us here.

  let voiceNonce = null; // set while we are waiting for a voice message

  function cancelVoice() {
    if (!voiceNonce) return;
    window.postMessage({ source: "ai-translate-voice", nonce: voiceNonce, cancel: true }, window.location.origin);
    voiceNonce = null;
  }

  function startVoice(nonce) {
    stopPicking();
    cancelVoice();
    voiceNonce = nonce;
    show({
      title: "AI Translate",
      text: "Press play on the voice message you want transcribed.",
      kind: "muted",
      buttons: [["Cancel", closeUi]],
    });
  }

  async function blobToBase64(blob) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    return dataUrl.slice(dataUrl.indexOf(",") + 1);
  }

  window.addEventListener("message", async (e) => {
    const d = e.data;
    if (!voiceNonce || e.source !== window || d?.source !== "ai-translate-voice" || d.nonce !== voiceNonce || d.cancel) return;
    voiceNonce = null;

    let { data, mime } = d;
    if (!d.ok && d.reason === "unreadable" && typeof d.src === "string") {
      // The page's own rules blocked the helper from reading the audio; try from here.
      try {
        const blob = await (await fetch(d.src)).blob();
        data = await blobToBase64(blob);
        mime = blob.type;
      } catch (_) {}
    }
    if (typeof data !== "string" || !data) {
      const text = d.reason === "too-large"
        ? "That recording is too long to transcribe."
        : "Could not read that audio. This player may not be supported.";
      show({ title: "AI Translate", text, kind: "err", buttons: [["Try another", retryVoice]] });
      return;
    }

    show({ title: "AI Translate", text: "Transcribing…", kind: "muted" });
    const res = await send({ type: "transcribe", data, mime });
    if (!res.ok) return showError(res, null, [["Try another", retryVoice]]);
    if (!res.transcript) {
      show({ title: "Voice message", text: "No speech found in that audio.", kind: "muted", buttons: [["Try another", retryVoice]] });
      return;
    }
    lastSource = res.transcript;
    const translated = !!res.translation;
    show({
      title: translated ? `Voice message (${res.language} to ${res.targetLang})` : `Voice message (${res.language})`,
      text: translated ? res.translation : res.transcript,
      content: translated ? [make("div", { className: "meta", textContent: `Original: ${res.transcript}` })] : [],
      buttons: [
        ["Reply", () => startCompose()],
        copyButton(translated ? res.translation : res.transcript),
        ...(translated ? [["Copy original", copyButton(res.transcript)[1]]] : []),
        ["Another", retryVoice],
      ],
    });
  });

  const retryVoice = () => send({ type: "retry-voice" });

  // ---- Block picker: hover to highlight a block, click to translate it ------

  let picking = null; // { el, trail } while the picker is active

  const hasText = (el) => /\p{L}/u.test(el.innerText ?? "");

  // The smallest sensible block around a hovered element: climb out of inline
  // wrappers (bold, links, emoji spans) and out of elements with no text.
  function blockFor(el) {
    while (el && el !== document.body && el !== document.documentElement) {
      if (hasText(el) && getComputedStyle(el).display !== "inline") return el;
      el = el.parentElement;
    }
    return null;
  }

  function highlight(el) {
    picking.el = el;
    if (!el) {
      els.pick.hidden = true;
      return;
    }
    const r = el.getBoundingClientRect();
    Object.assign(els.pick.style, {
      top: `${r.top - 2}px`, left: `${r.left - 2}px`,
      width: `${r.width + 4}px`, height: `${r.height + 4}px`,
    });
    els.pick.hidden = false;
  }

  const PICK_EVENTS = ["mousemove", "click", "mousedown", "mouseup", "pointerdown", "pointerup", "auxclick", "contextmenu", "keydown", "scroll"];

  function onPickEvent(e) {
    if (!picking) return;
    if (e.type === "scroll") return highlight(picking.el);
    if (e.type === "keydown") {
      if (e.key === "Escape") {
        closeUi();
      } else if (e.key === "ArrowUp" && picking.el?.parentElement && picking.el.parentElement !== document.documentElement) {
        picking.trail.push(picking.el);
        highlight(picking.el.parentElement);
      } else if (e.key === "ArrowDown" && picking.trail.length) {
        highlight(picking.trail.pop());
      } else {
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (e.target === host) return; // our own panel stays clickable
    if (e.type === "mousemove") {
      const el = blockFor(e.target);
      if (el !== picking.el && !picking.trail.includes(el)) {
        picking.trail = [];
        highlight(el);
      }
      return;
    }
    // Swallow the click so the page does not react to it.
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type !== "click") return;
    const el = picking.el ?? blockFor(e.target);
    if (!el) return;
    const text = (el.innerText ?? "").trim();
    const anchor = el.getBoundingClientRect();
    stopPicking();
    if (text.length > MAX_BLOCK_CHARS) {
      show({ title: "AI Translate", text: "That block is very large. Pick a smaller one, or use Translate page.", kind: "err", anchor: null });
      return;
    }
    translateText(text, anchor);
  }

  function startPicking() {
    stopPicking();
    show({
      title: "AI Translate",
      text: "Click a block of text to translate it.\nUp/Down arrows grow or shrink the block. Esc cancels.",
      kind: "muted",
    });
    picking = { el: null, trail: [] };
    for (const type of PICK_EVENTS) window.addEventListener(type, onPickEvent, true);
  }

  function stopPicking() {
    if (!picking) return;
    picking = null;
    for (const type of PICK_EVENTS) window.removeEventListener(type, onPickEvent, true);
    if (els) els.pick.hidden = true;
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
    stopPicking();
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
    else if (msg?.type === "translate-block") startPicking();
    else if (msg?.type === "compose-reply") startCompose();
    else if (msg?.type === "transcribe-voice") startVoice(msg.nonce);
    else if (msg?.type === "translate-page") translatePage();
    else if (msg?.type === "restore-page") restorePage();
  });
})();
