// Provider metadata (kept in sync with background.js / content.js).
const PROVIDERS = {
  minimax: {
    label: "MiniMax",
    models: ["MiniMax-M2.7", "MiniMax-M2.5", "MiniMax-M2.1", "MiniMax-M2", "MiniMax-M3"],
    defaultModel: "MiniMax-M2.7",
    hint: "Get a key from platform.minimax.io.",
  },
  gemini: {
    label: "Gemini",
    models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite", "gemini-3.5-flash", "gemini-3-flash-preview"],
    defaultModel: "gemini-2.5-flash",
    hint: "Get a key from aistudio.google.com/apikey.",
  },
};
const PROVIDER_ORDER = ["minimax", "gemini"];

const providerEl = document.getElementById("provider");
const apiKeyEl = document.getElementById("apiKey");
const modelEl = document.getElementById("model");
const hintEl = document.getElementById("hint");
const statusEl = document.getElementById("status");

let stored = {};

function keyOf(p) {
  return stored[`${p}ApiKey`] || "";
}

function renderProviderFields(p) {
  const info = PROVIDERS[p];
  apiKeyEl.value = keyOf(p);
  const selectedModel = stored[`${p}Model`] || info.defaultModel;
  modelEl.innerHTML = info.models
    .map(
      (m) =>
        `<option value="${m}"${m === selectedModel ? " selected" : ""}>${m}</option>`
    )
    .join("");
  hintEl.textContent = `${info.hint} Defaults to ${info.defaultModel}.`;
}

async function load() {
  stored = await browser.storage.local.get([
    "minimaxApiKey", "geminiApiKey", "minimaxModel", "geminiModel", "activeProvider",
  ]);

  providerEl.innerHTML = PROVIDER_ORDER.map(
    (p) => `<option value="${p}">${PROVIDERS[p].label}</option>`
  ).join("");

  let selected = stored.activeProvider;
  if (!selected || !PROVIDERS[selected]) {
    selected = PROVIDER_ORDER.find((p) => keyOf(p)) || "minimax";
  }
  providerEl.value = selected;
  renderProviderFields(selected);
}

providerEl.addEventListener("change", () => {
  renderProviderFields(providerEl.value);
  statusEl.textContent = "";
});

async function save() {
  const provider = providerEl.value;
  await browser.runtime.sendMessage({
    type: "saveApiKey",
    provider,
    key: apiKeyEl.value.trim(),
    model: modelEl.value,
    setActive: true,
  });
  // Keep the local copy in sync so switching providers shows saved values.
  stored[`${provider}ApiKey`] = apiKeyEl.value.trim();
  stored[`${provider}Model`] = modelEl.value;
  statusEl.textContent = "Saved ✓";
  setTimeout(() => (statusEl.textContent = ""), 2000);
}

document.getElementById("save").addEventListener("click", save);
load();
