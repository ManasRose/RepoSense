// MODULE A — Repo Ingestion
// Input:  a GitHub repo URL
// Output: [{ filePath, content, language }]

const fs = require("fs");
const path = require("path");
const os = require("os");
const simpleGit = require("simple-git");

// ---- Config ----
const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "coverage",
  "vendor", ".venv", "venv", "__pycache__", ".cache", "out",
]);

const IGNORE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".bmp",
  ".mp4", ".mov", ".mp3", ".wav", ".pdf", ".zip", ".tar", ".gz",
  ".woff", ".woff2", ".ttf", ".eot", ".lock", ".map",
]);

const IGNORE_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", ".DS_Store",
]);

const LANGUAGE_MAP = {
  ".js": "javascript", ".jsx": "javascript",
  ".ts": "typescript", ".tsx": "typescript",
  ".py": "python", ".java": "java", ".go": "go",
  ".rb": "ruby", ".php": "php", ".c": "c", ".cpp": "cpp",
  ".cs": "csharp", ".rs": "rust", ".md": "markdown",
  ".json": "json", ".html": "html", ".css": "css",
  ".yml": "yaml", ".yaml": "yaml",
};

const MAX_FILE_SIZE_BYTES = 300 * 1024; // skip files > 300kb (likely generated/minified)
const MAX_FILE_COUNT = 1500; // hard cap per repo for hackathon-scale ingestion

/**
 * Clone a public GitHub repo (shallow) into a temp dir.
 */
async function cloneRepo(repoUrl) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-intel-"));
  const git = simpleGit();
  await git.clone(repoUrl, tmpDir, ["--depth", "1"]);
  return tmpDir;
}

/**
 * Recursively walk a directory, returning normalized file objects.
 */
function walkDir(rootDir) {
  const results = [];

  function walk(currentDir) {
    if (results.length >= MAX_FILE_COUNT) return;

    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= MAX_FILE_COUNT) return;

      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(path.join(currentDir, entry.name));
        continue;
      }

      if (IGNORE_FILES.has(entry.name)) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (IGNORE_EXTENSIONS.has(ext)) continue;

      const fullPath = path.join(currentDir, entry.name);
      const stat = fs.statSync(fullPath);
      if (stat.size === 0 || stat.size > MAX_FILE_SIZE_BYTES) continue;

      let content;
      try {
        content = fs.readFileSync(fullPath, "utf-8");
      } catch {
        continue; // binary / unreadable
      }

      // Skip likely-binary content (null bytes)
      if (content.includes("\u0000")) continue;

      const relativePath = path.relative(rootDir, fullPath).split(path.sep).join("/");

      results.push({
        filePath: relativePath,
        content,
        language: LANGUAGE_MAP[ext] || "plaintext",
      });
    }
  }

  walk(rootDir);
  return results;
}

/**
 * Full ingestion pipeline: clone -> walk -> normalize -> cleanup.
 * @param {string} repoUrl
 * @returns {Promise<{ files: Array, fileCount: number, skipped: boolean }>}
 */
async function ingestRepo(repoUrl) {
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/.test(repoUrl.trim())) {
    throw new Error("Invalid GitHub repo URL. Expected format: https://github.com/owner/repo");
  }

  const tmpDir = await cloneRepo(repoUrl);
  try {
    const files = walkDir(tmpDir);
    return { files, fileCount: files.length };
  } finally {
    // cleanup temp clone regardless of success/failure
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { ingestRepo, walkDir, LANGUAGE_MAP };
