// MODULE D — Embedding Service
// Input:  [{ chunkId, filePath, text, metadata }]  (Module C output)
// Output: [{ chunkId, vector }]
//
// Uses a locally-running Ollama model instead of a cloud API — no API key,
// no rate limits, no cost. Requires Ollama running (`ollama serve`, usually
// automatic) with the model already pulled (`ollama pull gemma4:e4b-it-qat`).

const axios = require("axios");

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const EMBEDDING_MODEL =
  process.env.OLLAMA_EMBEDDING_MODEL ||
  process.env.OLLAMA_MODEL ||
  "gemma4:e4b-it-qat";
const BATCH_SIZE = 32; // local inference batches are memory-bound, not rate-limited — keep them modest
const MAX_RETRIES = 3;
// How long Ollama keeps this model loaded in RAM/VRAM after the last request.
// Default Ollama behavior unloads after 5m idle, which re-triggers a slow
// load_duration on the next call. Since this is single-user local use, keep
// it resident far longer (or "-1" to never unload) to avoid repeated reloads.
const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || "30m";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function friendlyError(err) {
  if (err.code === "ECONNREFUSED") {
    return new Error(
      `Can't reach Ollama at ${OLLAMA_BASE_URL}. Make sure Ollama is running (\`ollama serve\`) and reachable.`,
    );
  }
  if (err.response?.status === 404) {
    return new Error(
      `Ollama returned 404 for model "${EMBEDDING_MODEL}". Run \`ollama pull ${EMBEDDING_MODEL}\` first, or check the model name with \`ollama list\`.`,
    );
  }
  return err;
}

/**
 * Embed a batch of texts via Ollama's /api/embed endpoint (supports array input).
 */
async function embedBatch(texts, attempt = 1) {
  try {
    const response = await axios.post(`${OLLAMA_BASE_URL}/api/embed`, {
      model: EMBEDDING_MODEL,
      input: texts,
      keep_alive: KEEP_ALIVE,
    });
    return response.data.embeddings;
  } catch (err) {
    if (
      attempt <= MAX_RETRIES &&
      (err.code === "ECONNRESET" || err.code === "ETIMEDOUT")
    ) {
      await sleep(1000 * attempt);
      return embedBatch(texts, attempt + 1);
    }
    throw friendlyError(err);
  }
}

/**
 * Embed all chunks in batches of BATCH_SIZE.
 * @param {Array} chunks - Module C output
 * @param {(done:number,total:number)=>void} onProgress - optional progress callback
 * @returns {Promise<Array<{chunkId, vector}>>}
 */
async function embedChunks(chunks, onProgress) {
  const results = [];

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map((c) => c.text.slice(0, 8000));
    const vectors = await embedBatch(texts);

    batch.forEach((chunk, idx) => {
      results.push({ chunkId: chunk.chunkId, vector: vectors[idx] });
    });

    if (onProgress)
      onProgress(Math.min(i + BATCH_SIZE, chunks.length), chunks.length);
    console.log(
      `[embed] ${Math.min(i + BATCH_SIZE, chunks.length)}/${chunks.length} chunks embedded (local)`,
    );
  }

  return results;
}

/**
 * Embed a single piece of text (used for embedding the user's question).
 */
async function embedText(text) {
  try {
    const response = await axios.post(`${OLLAMA_BASE_URL}/api/embed`, {
      model: EMBEDDING_MODEL,
      input: text.slice(0, 8000),
      keep_alive: KEEP_ALIVE,
    });
    return response.data.embeddings[0];
  } catch (err) {
    throw friendlyError(err);
  }
}

module.exports = { embedChunks, embedText, EMBEDDING_MODEL };
