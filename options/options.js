// Provider metadata (kept in sync with background.js / content.js).
const PROVIDERS = {
  minimax: {
    label: "MiniMax",
    models: ["MiniMax-M2.7", "MiniMax-M2.5", "MiniMax-M2.1", "MiniMax-M2", "MiniMax-M3"],
    defaultModel: "MiniMax-M2.7",
    hint: "Get a key from platform.minimax.io.",
    keyPattern: /^[A-Za-z0-9._-]{20,}$/,
    keyError: "That doesn't look like a MiniMax key — expected a long token (20+ chars) with no spaces.",
  },
  gemini: {
    label: "Gemini",
    models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite", "gemini-3.5-flash", "gemini-3-flash-preview"],
    defaultModel: "gemini-2.5-flash",
    hint: "Get a key from aistudio.google.com/apikey.",
    keyPattern: /^AIza[A-Za-z0-9_-]{35}$/,
    keyError: 'That doesn\'t look like a Gemini key — it should start with "AIza" and be 39 characters.',
  },
  anthropic: {
    label: "Anthropic",
    models: ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-7"],
    defaultModel: "claude-haiku-4-5",
    hint: "Get a key from console.anthropic.com.",
    keyPattern: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
    keyError: 'That doesn\'t look like an Anthropic key — it should start with "sk-ant-".',
  },
};
const PROVIDER_ORDER = ["minimax", "gemini", "anthropic"];

// Validate a key's format. Empty is allowed (means "clear this key").
function validateKey(provider, key) {
  const value = (key || "").trim();
  if (!value) return { ok: true };
  if (/\s/.test(value)) {
    return { ok: false, message: "The key contains spaces or line breaks — paste only the key." };
  }
  const info = PROVIDERS[provider];
  if (info && info.keyPattern && !info.keyPattern.test(value)) {
    return { ok: false, message: info.keyError };
  }
  return { ok: true };
}

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
    ...PROVIDER_ORDER.map((p) => `${p}ApiKey`),
    ...PROVIDER_ORDER.map((p) => `${p}Model`),
    "activeProvider",
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
  setStatus("", false);
});
apiKeyEl.addEventListener("input", () => setStatus("", false));

function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", Boolean(isError));
}

async function save() {
  const provider = providerEl.value;
  const key = apiKeyEl.value.trim();
  const check = validateKey(provider, key);
  if (!check.ok) {
    setStatus(check.message, true);
    return;
  }
  const resp = await browser.runtime.sendMessage({
    type: "saveApiKey",
    provider,
    key,
    model: modelEl.value,
    setActive: true,
  });
  if (resp && resp.ok === false) {
    setStatus(resp.message || "Could not save the key.", true);
    return;
  }
  // Keep the local copy in sync so switching providers shows saved values.
  stored[`${provider}ApiKey`] = key;
  stored[`${provider}Model`] = modelEl.value;
  setStatus("Saved ✓", false);
  setTimeout(() => setStatus("", false), 2000);
}

document.getElementById("save").addEventListener("click", save);
load();
