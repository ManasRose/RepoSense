// Service worker: all fetch() calls to the backend live here.
// Popup and content script talk to the backend only through this bridge.

// Open the side panel when the toolbar icon is clicked.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error);

// The side panel stays open across tab switches/navigation (unlike the old
// popup, which fully unloaded on blur). Broadcast a lightweight "tab changed"
// signal so the panel can re-detect which repo it should be showing.
function notifyTabChanged() {
  chrome.runtime.sendMessage({ type: "ACTIVE_TAB_CHANGED" }).catch(() => {
    // no-op: fails harmlessly if the side panel isn't currently open
  });
}

chrome.tabs.onActivated.addListener(notifyTabChanged);
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.active) notifyTabChanged();
});

const API_BASE = "http://localhost:5000/api"; // change to your deployed backend URL

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case "INGEST_REPO": {
          const data = await apiFetch("/repo/ingest", {
            method: "POST",
            body: JSON.stringify({ repoUrl: message.repoUrl }),
          });
          sendResponse({ ok: true, data });
          break;
        }
        case "GET_STATUS": {
          const data = await apiFetch(`/repo/${message.repoId}/status`);
          sendResponse({ ok: true, data });
          break;
        }
        case "ASK_QUESTION": {
          const data = await apiFetch(`/repo/${message.repoId}/ask`, {
            method: "POST",
            body: JSON.stringify({ question: message.question }),
          });
          sendResponse({ ok: true, data });
          break;
        }
        case "INTERVIEW_MODE": {
          const data = await apiFetch(
            `/repo/${message.repoId}/interview-mode`,
            {
              method: "POST",
              body: JSON.stringify({ focusTopic: message.focusTopic || null }),
            },
          );
          sendResponse({ ok: true, data });
          break;
        }
        case "ARCHITECTURE_SUMMARY": {
          const data = await apiFetch(
            `/repo/${message.repoId}/architecture-summary`,
            {
              method: "POST",
            },
          );
          sendResponse({ ok: true, data });
          break;
        }
        case "FIND_BUGS": {
          const data = await apiFetch(`/repo/${message.repoId}/find-bugs`, {
            method: "POST",
            body: JSON.stringify({ focusPath: message.focusPath || null }),
          });
          sendResponse({ ok: true, data });
          break;
        }
        case "EXPLAIN_FUNCTION": {
          const data = await apiFetch(
            `/repo/${message.repoId}/explain-function`,
            {
              method: "POST",
              body: JSON.stringify({
                filePath: message.filePath,
                code: message.code,
              }),
            },
          );
          sendResponse({ ok: true, data });
          break;
        }
        default:
          sendResponse({ ok: false, error: "Unknown message type" });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true; // async response
});
