const api = globalThis.browser ?? globalThis.chrome;

const lang = document.getElementById("lang");
const status = document.getElementById("status");
const keyState = document.getElementById("key-state");

fillLanguageList(document.getElementById("langs"));

async function saveLang() {
  const value = lang.value.trim();
  if (value) await api.storage.local.set({ targetLang: value });
}

(async () => {
  const { targetLang = "English", apiKey = "" } = await api.storage.local.get(["targetLang", "apiKey"]);
  lang.value = targetLang;
  keyState.textContent = apiKey ? "API key saved on this device" : "No API key yet";
})();

lang.addEventListener("change", saveLang);

for (const button of document.querySelectorAll("[data-action]")) {
  button.addEventListener("click", async () => {
    status.textContent = "";
    await saveLang();
    const res = await api.runtime.sendMessage({ type: "run-action", action: button.dataset.action });
    if (res?.ok) window.close();
    else status.textContent = res?.error ?? "Something went wrong.";
  });
}

document.getElementById("settings").addEventListener("click", () => {
  api.runtime.openOptionsPage();
  window.close();
});
