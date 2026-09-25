// Detects the current repo (and file, if viewing one) on github.com,
// and responds to requests from the popup/background for that context.

function parseGithubContext() {
  const path = window.location.pathname.split("/").filter(Boolean); // e.g. ["owner","repo","blob","main","src/x.js"]
  if (path.length < 2) return null;

  const owner = path[0];
  const repo = path[1];
  const repoUrl = `https://github.com/${owner}/${repo}`;

  let filePath = null;
  if (path[2] === "blob" && path.length > 4) {
    filePath = path.slice(4).join("/");
  }

  // Grab selected text in the code view, if any (for "Explain this" / function explainer)
  const selection = window.getSelection()?.toString() || "";

  return { owner, repo, repoUrl, filePath, selection };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_GITHUB_CONTEXT") {
    sendResponse(parseGithubContext());
  }
  return true; // keep the message channel open for async response
});

// Optional: inject a lightweight "Explain this" affordance when text is selected
// on a code page (stretch feature from the roadmap).
document.addEventListener("mouseup", () => {
  const selection = window.getSelection()?.toString().trim();
  if (selection && selection.length > 10 && window.location.pathname.includes("/blob/")) {
    chrome.runtime.sendMessage({ type: "TEXT_SELECTED", text: selection });
  }
});
