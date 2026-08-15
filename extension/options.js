const DEFAULT_PORT = 10100;

const portInput = document.getElementById("port");
const status = document.getElementById("status");

function setStatus(text, tone) {
  status.textContent = text;
  if (tone) status.dataset.tone = tone;
  else delete status.dataset.tone;
}

async function load() {
  const { ocxPort } = await chrome.storage.local.get({ ocxPort: DEFAULT_PORT });
  portInput.value = String(ocxPort || DEFAULT_PORT);
}

function readPort() {
  const value = Number(portInput.value);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) return null;
  return value;
}

document.getElementById("save").addEventListener("click", async () => {
  const port = readPort();
  if (port === null) {
    setStatus("Enter a port between 1 and 65535.", "error");
    return;
  }
  await chrome.storage.local.set({ ocxPort: port });
  setStatus(`Saved — captures will target 127.0.0.1:${port}.`, "ok");
});

document.getElementById("test").addEventListener("click", async () => {
  const port = readPort();
  if (port === null) {
    setStatus("Enter a port between 1 and 65535.", "error");
    return;
  }
  setStatus("Checking…", null);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body?.service !== "opencodex") throw new Error("something else is listening on this port");
    setStatus(`Connected — opencodex ${body.version ?? ""} is running.`, "ok");
  } catch (err) {
    setStatus(`Could not reach opencodex on port ${port}: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
});

void load();
