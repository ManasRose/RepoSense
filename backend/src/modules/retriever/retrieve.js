// MODULE F — Retriever
// Input:  repoId, natural-language question
// Output: ranked list of relevant chunks + file references

const { embedText } = require("../embedding/embed");
const vectorstore = require("../vectordb/vectorstore");

const DEFAULT_TOP_K = 8;
const CANDIDATE_MULTIPLIER = 3; // pull more than topK, then re-rank

/**
 * Cheap keyword-boost re-ranking: bumps score for chunks whose text/filePath
 * contains literal words from the query (handles identifier/function-name
 * matches that pure embedding similarity sometimes misses).
 */
function keywordBoost(chunks, question) {
  const keywords = question
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);

  return chunks
    .map((chunk) => {
      const haystack = (chunk.filePath + " " + chunk.text).toLowerCase();
      const matches = keywords.filter((k) => haystack.includes(k)).length;
      const boost = matches * 0.02; // small nudge, embedding similarity still dominates
      return { ...chunk, score: chunk.score + boost };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Retrieve the most relevant code chunks for a question.
 * @param {string} repoId
 * @param {string} question
 * @param {number} topK
 * @returns {Promise<Array>} chunks with { chunkId, filePath, text, metadata, score }
 */
async function retrieve(repoId, question, topK = DEFAULT_TOP_K) {
  if (!(await vectorstore.namespaceExists(repoId))) {
    throw new Error(`Repo ${repoId} has not been indexed yet.`);
  }

  const queryVector = await embedText(question);
  const candidates = await vectorstore.query(
    repoId,
    queryVector,
    topK * CANDIDATE_MULTIPLIER,
  );
  const reranked = keywordBoost(candidates, question);

  return reranked.slice(0, topK);
}

/**
 * Convenience: format retrieved chunks as { filePath, startLine, endLine } references.
 */
function toReferences(chunks) {
  return chunks.map((c) => ({
    filePath: c.filePath,
    startLine: c.metadata?.startLine,
    endLine: c.metadata?.endLine,
  }));
}

module.exports = { retrieve, toReferences };
