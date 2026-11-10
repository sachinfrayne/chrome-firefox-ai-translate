const api = globalThis.browser ?? globalThis.chrome;

const DEFAULT_MODEL = "gemini-flash-latest";
const $ = (id) => document.getElementById(id);
const key = $("key"), model = $("model"), lang = $("lang"), status = $("status");

fillLanguageList($("langs"));

function setStatus(text, kind = "") {
  status.textContent = text;
  status.className = `status ${kind}`;
}

function setModels(models, selected) {
  model.textContent = "";
  if (!models.some((m) => m.id === selected)) models = [{ id: selected, label: selected }, ...models];
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label === m.id ? m.id : `${m.label} (${m.id})`;
    model.appendChild(opt);
  }
  model.value = selected;
}

(async () => {
  const s = await api.storage.local.get(["apiKey", "model", "targetLang"]);
  key.value = s.apiKey ?? "";
  lang.value = s.targetLang ?? "English";
  setModels([], s.model ?? DEFAULT_MODEL);
})();

$("toggle").addEventListener("click", () => {
  const hidden = key.type === "password";
  key.type = hidden ? "text" : "password";
  $("toggle").textContent = hidden ? "Hide" : "Show";
});

$("load-models").addEventListener("click", async () => {
  setStatus("Checking key…");
  const res = await api.runtime.sendMessage({ type: "list-models", apiKey: key.value.trim() });
  if (!res?.ok) return setStatus(res?.error ?? "Could not reach Gemini.", "err");
  setModels(res.models, model.value || DEFAULT_MODEL);
  setStatus(`Key works. ${res.models.length} models available. Remember to save.`, "ok");
});

$("save").addEventListener("click", async () => {
  await api.storage.local.set({
    apiKey: key.value.trim(),
    model: model.value || DEFAULT_MODEL,
    targetLang: lang.value.trim() || "English",
  });
  setStatus("Saved.", "ok");
});

$("remove").addEventListener("click", async () => {
  await api.storage.local.remove("apiKey");
  key.value = "";
  setStatus("Key removed from this browser.", "ok");
});
