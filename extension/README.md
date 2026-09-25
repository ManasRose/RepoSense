# GitHub Repo Intelligence — Chrome Extension (Module K)

Thin client that runs on github.com and talks to the backend API.

## Load it

1. Make sure the backend is running on `http://localhost:5000` (see `../backend/README.md`).
2. Go to `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked**, select this `extension/` folder.
4. Navigate to any GitHub repo (e.g. `https://github.com/facebook/react`), click the
   extension icon.

## Files

- `manifest.json` — Manifest V3 config, permissions for `github.com/*` and `localhost:5000`
- `content-script.js` — detects the current repo/file from the GitHub page URL
- `background.js` — service worker; **all** `fetch()` calls to the backend live here
- `popup.html` / `popup.css` / `popup.js` — chat UI, Interview Mode, Architecture Summary, Find Bugs

## Pointing at a deployed backend

Change `API_BASE` at the top of `background.js` from `http://localhost:5000/api` to your
deployed URL (e.g. Render/Railway), and add that URL to `host_permissions` in `manifest.json`.

## Stretch features (not yet built, noted in the plan)

- Inline sidebar injected into GitHub's DOM
- Right-click "Explain this" context menu (the content script already captures text
  selections on `/blob/` pages via `TEXT_SELECTED` messages — wire this up to
  `EXPLAIN_FUNCTION` in `background.js` to finish it)
- PR/diff explainer
