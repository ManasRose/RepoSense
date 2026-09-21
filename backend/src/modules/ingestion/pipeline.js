// Orchestrates Module A -> B -> C -> D -> E as one background job,
// updating Repo.status in Mongo (or in-memory map in demo mode) as it goes.

const crypto = require("crypto");
const { ingestRepo } = require("../ingestion/ingest");
const { parseFiles } = require("../parser/parse");
const { chunkUnits } = require("../chunking/chunk");
const { embedChunks } = require("../embedding/embed");
const vectorstore = require("../vectordb/vectorstore");
const { Repo } = require("../db/models");

// In-memory fallback job store, used when MongoDB isn't connected (demo mode).
const memoryJobs = new Map(); // repoId -> { status, error, fileCount, chunkCount, repoUrl }

function makeRepoId(repoUrl) {
  return crypto
    .createHash("sha1")
    .update(repoUrl.trim().toLowerCase())
    .digest("hex")
    .slice(0, 16);
}

async function setStatus(repoId, repoUrl, patch) {
  memoryJobs.set(repoId, {
    ...(memoryJobs.get(repoId) || { repoUrl }),
    ...patch,
  });
  try {
    await Repo.findOneAndUpdate(
      { repoId },
      { repoId, repoUrl, ...patch },
      { upsert: true, new: true },
    );
  } catch {
    // Mongo not connected — memory store above is the source of truth in demo mode
  }
}

async function getStatus(repoId) {
  try {
    const doc = await Repo.findOne({ repoId });
    if (doc) return doc.toObject();
  } catch {
    // fall through to memory
  }
  return memoryJobs.get(repoId) || null;
}

/**
 * Kick off the full ingestion pipeline for a repo URL. Returns immediately
 * with a repoId; the actual work happens async and status can be polled.
 */
function startIngestion(repoUrl) {
  const repoId = makeRepoId(repoUrl);

  // fire-and-forget background job
  (async () => {
    try {
      await setStatus(repoId, repoUrl, { status: "cloning", error: null });
      const { files, fileCount } = await ingestRepo(repoUrl);

      await setStatus(repoId, repoUrl, { status: "parsing", fileCount });
      const units = parseFiles(files);
      const chunks = chunkUnits(units);

      await setStatus(repoId, repoUrl, {
        status: "embedding",
        chunkCount: chunks.length,
      });
      const vectors = await embedChunks(chunks);

      // chunkIds are fresh UUIDs each run, so wipe the old collection first
      // (after embedding succeeds, so a failed run doesn't destroy the existing index)
      await vectorstore.clearNamespace(repoId);
      await vectorstore.upsert(repoId, chunks, vectors);

      await setStatus(repoId, repoUrl, {
        status: "ready",
        indexedAt: new Date(),
      });
    } catch (err) {
      await setStatus(repoId, repoUrl, {
        status: "failed",
        error: err.message,
      });
    }
  })();

  return repoId;
}

module.exports = { startIngestion, getStatus, makeRepoId };
