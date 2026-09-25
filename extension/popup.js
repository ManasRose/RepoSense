const repoLabel = document.getElementById("repo-label");
const statusBar = document.getElementById("status-bar");
const messagesEl = document.getElementById("messages");
const emptyStateEl = document.getElementById("empty-state");
const loadingEl = document.getElementById("loading-indicator");
const questionInput = document.getElementById("question-input");

const btnIndex = document.getElementById("btn-index");
const btnArch = document.getElementById("btn-arch");
const btnInterview = document.getElementById("btn-interview");
const btnBugs = document.getElementById("btn-bugs");
const btnAsk = document.getElementById("btn-ask");
const btnClear = document.getElementById("btn-clear");

let currentContext = null; // { owner, repo, repoUrl }
let currentRepoId = null;
let pollTimer = null;

// --- Persistence (chrome.storage.local, keyed by repoUrl since that's stable
// and known client-side without duplicating the backend's hashing logic) ---

function storageKey(repoUrl) {
  return `panel_state:${repoUrl}`;
}

async function loadState(repoUrl) {
  const result = await chrome.storage.local.get(storageKey(repoUrl));
  return result[storageKey(repoUrl)] || null;
}

async function saveState(repoUrl, state) {
  await chrome.storage.local.set({ [storageKey(repoUrl)]: state });
}

let currentMessages = []; // in-memory mirror of what's persisted for the active repo

async function persist() {
  if (!currentContext) return;
  await saveState(currentContext.repoUrl, {
    repoId: currentRepoId,
    messages: currentMessages,
  });
}

// --- UI helpers ---

function renderMessage(role, text, references = [], isError = false) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;

  const bubble = document.createElement("div");
  bubble.className = `bubble${isError ? " error" : ""}`;
  bubble.textContent = text;
  div.appendChild(bubble);

  if (references?.length) {
    const refsDiv = document.createElement("div");
    refsDiv.className = "refs";
    references.forEach((r) => {
      if (!r.filePath) return;
      const span = document.createElement("span");
      span.textContent = `📄 ${r.filePath}${r.startLine ? `:${r.startLine}-${r.endLine}` : ""}`;
      refsDiv.appendChild(span);
    });
    div.appendChild(refsDiv);
  }

  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  emptyStateEl.classList.add("hidden");
}

function renderAllMessages() {
  messagesEl.querySelectorAll(".msg").forEach((el) => el.remove());
  if (currentMessages.length === 0) {
    emptyStateEl.classList.remove("hidden");
  } else {
    emptyStateEl.classList.add("hidden");
    currentMessages.forEach((m) =>
      renderMessage(m.role, m.text, m.references, m.isError),
    );
  }
}

async function addMessage(role, text, references = [], isError = false) {
  currentMessages.push({ role, text, references, isError });
  renderMessage(role, text, references, isError);
  await persist();
}

function setStatusBar(text, variant = "info", visible = true) {
  statusBar.textContent = text;
  statusBar.classList.toggle("hidden", !visible);
  statusBar.classList.toggle("error", variant === "error");
  statusBar.classList.toggle("success", variant === "success");
}

function setLoading(isLoading) {
  loadingEl.classList.toggle("hidden", !isLoading);
  btnAsk.disabled = isLoading || questionInput.disabled;
}

function enableRepoActions(enabled) {
  [btnArch, btnInterview, btnBugs, questionInput, btnAsk].forEach(
    (el) => (el.disabled = !enabled),
  );
}

function sendToBackground(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

// --- Context detection & refresh (called on load and whenever the active tab changes) ---

async function getActiveTabContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tab.id,
      { type: "GET_GITHUB_CONTEXT" },
      (context) => {
        if (chrome.runtime.lastError || !context) return resolve(null);
        resolve(context);
      },
    );
  });
}

async function refreshContext() {
  const context = await getActiveTabContext();

  // Not on a GitHub repo page
  if (!context) {
    currentContext = null;
    currentRepoId = null;
    clearInterval(pollTimer);
    repoLabel.textContent = "Open a GitHub repo to get started";
    setStatusBar("", "info", false);
    btnIndex.disabled = true;
    enableRepoActions(false);
    currentMessages = [];
    renderAllMessages();
    return;
  }

  // Already showing this repo — nothing to refresh
  if (currentContext?.repoUrl === context.repoUrl) return;

  currentContext = context;
  repoLabel.textContent = `${context.owner}/${context.repo}`;
  btnIndex.disabled = false;
  clearInterval(pollTimer);

  const saved = await loadState(context.repoUrl);
  if (saved) {
    currentRepoId = saved.repoId;
    currentMessages = saved.messages || [];
    renderAllMessages();

    // Re-check status in case the backend restarted since we last saw this repo
    // (in-memory demo mode loses job state on restart).
    const res = await sendToBackground({
      type: "GET_STATUS",
      repoId: currentRepoId,
    });
    if (res.ok && res.data.status === "ready") {
      setStatusBar("Repo indexed ✓ Ask away.", "success");
      enableRepoActions(true);
    } else if (res.ok && res.data.status === "failed") {
      setStatusBar(`Failed: ${res.data.error}`, "error");
      enableRepoActions(false);
    } else if (res.ok) {
      setStatusBar(`Status: ${res.data.status}…`);
      enableRepoActions(false);
      pollStatus();
    } else {
      // backend doesn't recognize this repoId anymore — needs re-indexing
      setStatusBar("This repo needs re-indexing (backend restarted).", "error");
      enableRepoActions(false);
    }
  } else {
    currentRepoId = null;
    currentMessages = [];
    renderAllMessages();
    setStatusBar("", "info", false);
    enableRepoActions(false);
  }
}

// --- Ingestion ---

btnIndex.addEventListener("click", async () => {
  if (!currentContext) return;
  btnIndex.disabled = true;
  setStatusBar("Starting ingestion…");

  const res = await sendToBackground({
    type: "INGEST_REPO",
    repoUrl: currentContext.repoUrl,
  });
  if (!res.ok) {
    setStatusBar(`Error: ${res.error}`, "error");
    btnIndex.disabled = false;
    return;
  }

  currentRepoId = res.data.repoId;
  await persist();
  pollStatus();
});

function pollStatus() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const res = await sendToBackground({
      type: "GET_STATUS",
      repoId: currentRepoId,
    });
    if (!res.ok) {
      setStatusBar(`Error: ${res.error}`, "error");
      clearInterval(pollTimer);
      btnIndex.disabled = false;
      return;
    }

    const { status, fileCount, chunkCount, embeddedCount, error } = res.data;
    let label = `Status: ${status}`;
    if (fileCount) label += ` · ${fileCount} files`;
    if (chunkCount) label += ` · ${chunkCount} chunks`;
    if (typeof embeddedCount === "number" && chunkCount)
      label += ` (${embeddedCount}/${chunkCount} embedded)`;
    setStatusBar(label);

    if (status === "ready") {
      clearInterval(pollTimer);
      setStatusBar("Repo indexed ✓ Ask away.", "success");
      enableRepoActions(true);
      btnIndex.disabled = false;
    } else if (status === "failed") {
      clearInterval(pollTimer);
      setStatusBar(`Failed: ${error}`, "error");
      btnIndex.disabled = false;
    }
  }, 3000);
}

// --- Actions ---

btnAsk.addEventListener("click", async () => {
  const question = questionInput.value.trim();
  if (!question || !currentRepoId) return;
  await addMessage("user", question);
  questionInput.value = "";
  setLoading(true);

  const res = await sendToBackground({
    type: "ASK_QUESTION",
    repoId: currentRepoId,
    question,
  });
  setLoading(false);
  if (!res.ok) return addMessage("assistant", `Error: ${res.error}`, [], true);
  await addMessage("assistant", res.data.answer, res.data.references);
});

questionInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") btnAsk.click();
});

btnArch.addEventListener("click", async () => {
  await addMessage("user", "Give me an architecture summary");
  setLoading(true);
  const res = await sendToBackground({
    type: "ARCHITECTURE_SUMMARY",
    repoId: currentRepoId,
  });
  setLoading(false);
  if (!res.ok) return addMessage("assistant", `Error: ${res.error}`, [], true);
  await addMessage("assistant", res.data.answer, res.data.references);
});

btnInterview.addEventListener("click", async () => {
  await addMessage("user", "Generate interview questions for this repo");
  setLoading(true);
  const res = await sendToBackground({
    type: "INTERVIEW_MODE",
    repoId: currentRepoId,
  });
  setLoading(false);
  if (!res.ok) return addMessage("assistant", `Error: ${res.error}`, [], true);
  await addMessage("assistant", res.data.answer, res.data.references);
});

btnBugs.addEventListener("click", async () => {
  await addMessage("user", "Find potential bugs in this repo");
  setLoading(true);
  const res = await sendToBackground({
    type: "FIND_BUGS",
    repoId: currentRepoId,
  });
  setLoading(false);
  if (!res.ok) return addMessage("assistant", `Error: ${res.error}`, [], true);
  await addMessage("assistant", res.data.answer, res.data.references);
});

btnClear.addEventListener("click", async () => {
  if (!currentContext) return;
  if (!confirm("Clear chat history for this repo?")) return;
  currentMessages = [];
  renderAllMessages();
  await persist();
});

// --- Wire up tab-change tracking so the panel updates without needing to reopen ---

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "ACTIVE_TAB_CHANGED") refreshContext();
});

refreshContext();
