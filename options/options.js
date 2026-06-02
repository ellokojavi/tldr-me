const apiKeyEl = document.getElementById("apiKey");
const modelEl = document.getElementById("model");
const statusEl = document.getElementById("status");

async function load() {
  const { minimaxApiKey, model } = await browser.storage.local.get([
    "minimaxApiKey",
    "model",
  ]);
  if (minimaxApiKey) apiKeyEl.value = minimaxApiKey;
  if (model) modelEl.value = model;
}

async function save() {
  await browser.storage.local.set({
    minimaxApiKey: apiKeyEl.value.trim(),
    model: modelEl.value,
  });
  statusEl.textContent = "Saved ✓";
  setTimeout(() => (statusEl.textContent = ""), 2000);
}

document.getElementById("save").addEventListener("click", save);
load();
