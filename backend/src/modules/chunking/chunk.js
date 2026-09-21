// MODULE C — Chunking Engine
// Input:  [{ filePath, name, type, startLine, endLine, code }]  (Module B output)
// Output: [{ chunkId, filePath, text, metadata }]

const { v4: uuidv4 } = require("uuid");

const MIN_CHUNK_CHARS = 80;      // units smaller than this get merged with neighbors
const MAX_CHUNK_CHARS = 2500;    // units larger than this get sub-split
const OVERLAP_LINES = 3;         // lines of overlap when sub-splitting large units

/**
 * Merge consecutive small units from the same file into one chunk.
 */
function mergeSmallUnits(units) {
  const merged = [];
  let buffer = null;

  for (const unit of units) {
    if (buffer && buffer.filePath === unit.filePath && buffer.code.length < MIN_CHUNK_CHARS) {
      // merge into buffer
      buffer.code += "\n\n" + unit.code;
      buffer.endLine = unit.endLine;
      buffer.names.push(unit.name);
      continue;
    }
    if (buffer) merged.push(buffer);
    buffer = { ...unit, names: [unit.name].filter(Boolean) };
  }
  if (buffer) merged.push(buffer);
  return merged;
}

/**
 * Split a large unit into overlapping sub-chunks by line count.
 */
function splitLargeUnit(unit) {
  if (unit.code.length <= MAX_CHUNK_CHARS) return [unit];

  const lines = unit.code.split("\n");
  const approxLinesPerChunk = Math.ceil(MAX_CHUNK_CHARS / (unit.code.length / lines.length));
  const subChunks = [];

  let i = 0;
  while (i < lines.length) {
    const end = Math.min(i + approxLinesPerChunk, lines.length);
    const slice = lines.slice(Math.max(0, i - OVERLAP_LINES), end);
    subChunks.push({
      ...unit,
      code: slice.join("\n"),
      startLine: unit.startLine + Math.max(0, i - OVERLAP_LINES),
      endLine: unit.startLine + end - 1,
    });
    i = end;
  }
  return subChunks;
}

/**
 * Build a short header comment for retrieval quality, e.g.:
 * // File: controllers/authController.js | Function: loginUser (lines 12-34)
 */
function buildHeader(unit) {
  const name = unit.name || (unit.names && unit.names.filter(Boolean).join(", ")) || null;
  const label = name ? `${unit.type || "block"}: ${name}` : (unit.type || "block");
  return `// File: ${unit.filePath} | ${label} (lines ${unit.startLine}-${unit.endLine})`;
}

/**
 * Full chunking pipeline.
 * @param {Array} units - Module B output
 * @returns {Array} chunks - Module C output
 */
function chunkUnits(units) {
  const merged = mergeSmallUnits(units);
  const chunks = [];

  for (const unit of merged) {
    const subUnits = splitLargeUnit(unit);
    for (const sub of subUnits) {
      const header = buildHeader(sub);
      chunks.push({
        chunkId: uuidv4(),
        filePath: sub.filePath,
        text: `${header}\n${sub.code}`,
        metadata: {
          name: sub.name || null,
          type: sub.type || "block",
          startLine: sub.startLine,
          endLine: sub.endLine,
        },
      });
    }
  }

  return chunks;
}

module.exports = { chunkUnits };
