// MODULE G — LLM Orchestrator (the "brain")
// Input:  retrieved chunks + user question (or a feature mode)
// Output: { answer, references }
//
// Uses a locally-running Ollama model instead of a cloud API.

const axios = require("axios");
const { retrieve, toReferences } = require("../retriever/retrieve");

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL || "gemma4:e4b-it-qat";
// Keep the chat model resident too, for the same reason as the embedding model.
const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || "30m";

// Latency tuning knobs (all optional; unset = previous behavior).
//   OLLAMA_NUM_PREDICT    cap on generated tokens, e.g. 400
//   ASK_TOP_K             chunks sent to the model for /ask (default 8)
//   PROMPT_CHUNK_MAX_CHARS  truncate each snippet in the prompt, e.g. 1200 (0 = no limit)
const NUM_PREDICT = Number(process.env.OLLAMA_NUM_PREDICT) || null;
const ASK_TOP_K = Number(process.env.ASK_TOP_K) || 8;
const PROMPT_CHUNK_MAX_CHARS = Number(process.env.PROMPT_CHUNK_MAX_CHARS) || 0;

function formatChunksForPrompt(chunks) {
  return chunks
    .map((c, i) => {
      const text =
        PROMPT_CHUNK_MAX_CHARS && c.text.length > PROMPT_CHUNK_MAX_CHARS
          ? c.text.slice(0, PROMPT_CHUNK_MAX_CHARS) + "\n// ...truncated"
          : c.text;
      return `--- Snippet ${i + 1} (${c.filePath}, lines ${c.metadata?.startLine}-${c.metadata?.endLine}) ---\n${text}`;
    })
    .join("\n\n");
}

const BASE_SYSTEM_PROMPT = `You are a senior engineer explaining a codebase to a colleague.
You are given retrieved code snippets (with file paths and line numbers) and a question.
Rules:
- Ground every claim in the provided code. Do not invent code, files, or behavior that isn't shown.
- If the code doesn't contain enough information to answer confidently, say so plainly rather than guessing.
- When you reference specific code, cite it inline like [routes/auth.js:12-34].
- Be concise and technical. Assume the reader is a competent engineer, not a beginner.
- Never mention "chunks", "retrieved snippets", or anything about how the code was given to you —
  just answer as if you're reading the file directly. Do not narrate your own process
  (e.g. "since these two chunks are identical, I merged them") — just give the answer.`;

/** Remove duplicate {filePath, startLine, endLine} entries, preserving order. */
function dedupeReferences(refs) {
  const seen = new Set();
  return refs.filter((r) => {
    const key = `${r.filePath}:${r.startLine}-${r.endLine}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function friendlyError(err) {
  if (err.code === "ECONNREFUSED") {
    return new Error(
      `Can't reach Ollama at ${OLLAMA_BASE_URL}. Make sure Ollama is running (\`ollama serve\`) and reachable.`,
    );
  }
  if (err.response?.status === 404) {
    return new Error(
      `Ollama returned 404 for model "${MODEL}". Run \`ollama pull ${MODEL}\` first, or check the model name with \`ollama list\`.`,
    );
  }
  return err;
}

const sec = (ns) => ((ns || 0) / 1e9).toFixed(1);

async function callOllama(systemPrompt, userPrompt) {
  try {
    const body = {
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      stream: false,
      keep_alive: KEEP_ALIVE,
    };
    if (NUM_PREDICT) body.options = { num_predict: NUM_PREDICT };

    const response = await axios.post(`${OLLAMA_BASE_URL}/api/chat`, body);
    const d = response.data;

    // Timing breakdown: shows whether latency is model load, prompt processing, or generation.
    if (d.eval_duration) {
      console.log(
        `[ollama] load ${sec(d.load_duration)}s | ` +
          `prompt ${d.prompt_eval_count} tok in ${sec(d.prompt_eval_duration)}s | ` +
          `output ${d.eval_count} tok in ${sec(d.eval_duration)}s ` +
          `(${(d.eval_count / (d.eval_duration / 1e9)).toFixed(1)} tok/s)`,
      );
    }
    return d.message.content;
  } catch (err) {
    throw friendlyError(err);
  }
}

/** Extract [filePath:startLine-endLine] citations the model emitted, as structured refs. */
function extractCitations(answerText) {
  const regex = /\[([^\[\]:]+):(\d+)-(\d+)\]/g;
  const refs = [];
  let match;
  while ((match = regex.exec(answerText)) !== null) {
    refs.push({
      filePath: match[1],
      startLine: Number(match[2]),
      endLine: Number(match[3]),
    });
  }
  return refs;
}

/**
 * Core Q&A: retrieve + generate grounded answer with citations.
 */
async function askQuestion(repoId, question) {
  const chunks = await retrieve(repoId, question, ASK_TOP_K);

  if (chunks.length === 0) {
    return {
      answer:
        "I don't have enough indexed context to answer that. Try re-indexing the repo or asking about a more specific file/feature.",
      references: [],
    };
  }

  const prompt = `Question: ${question}\n\nRetrieved code:\n${formatChunksForPrompt(chunks)}`;
  const answer = await callOllama(BASE_SYSTEM_PROMPT, prompt);
  const citedRefs = extractCitations(answer);

  return {
    answer,
    references: dedupeReferences(
      citedRefs.length > 0 ? citedRefs : toReferences(chunks),
    ),
  };
}

/**
 * Architecture Summary — run once on repo load over a broad sample of chunks.
 */
async function architectureSummary(repoId) {
  const chunks = await retrieve(
    repoId,
    "overall project structure, entry points, routes, models, main modules",
    20,
  );
  const prompt = `Based on these code chunks, write a concise architecture summary covering:
1. What this project does (1-2 sentences)
2. Main components/modules and their responsibilities
3. Key entry points (server start, main routes)
4. Notable patterns or libraries used

Code:\n${formatChunksForPrompt(chunks)}`;
  const answer = await callOllama(BASE_SYSTEM_PROMPT, prompt);
  return { answer, references: dedupeReferences(toReferences(chunks)) };
}

/**
 * Interview Mode — tiered questions grounded in actual repo content.
 */
async function interviewMode(repoId, focusTopic) {
  const query =
    focusTopic || "core application logic, main features, architecture";
  const chunks = await retrieve(repoId, query, 15);
  const prompt = `Generate interview questions based ONLY on this actual codebase, organized into four tiers:
- Easy (2 questions): basic understanding of what specific code does
- Medium (2 questions): design decisions and trade-offs visible in the code
- Hard (2 questions): edge cases, potential bugs, or scalability concerns in this code
- System Design (1 question): how you'd extend or scale this specific system

For each question, briefly note which file(s) it relates to. Code:\n${formatChunksForPrompt(chunks)}`;
  const answer = await callOllama(BASE_SYSTEM_PROMPT, prompt);
  return { answer, references: dedupeReferences(toReferences(chunks)) };
}

/**
 * Bug Finder — scan chunks for common anti-patterns.
 */
async function findBugs(repoId, focusPath) {
  const query = focusPath
    ? `code in ${focusPath}`
    : "error handling, input validation, async logic, security-sensitive code";
  const chunks = await retrieve(repoId, query, 15);
  const prompt = `Review this code for real issues only — do not invent problems that aren't there:
- Missing error handling
- Unvalidated input / injection risks
- Unhandled promise rejections or race conditions
- Obvious logic bugs
- Security concerns (secrets, auth gaps)

For each issue found, cite the file/lines and explain the risk briefly. If nothing significant stands out, say so honestly. Code:\n${formatChunksForPrompt(chunks)}`;
  const answer = await callOllama(BASE_SYSTEM_PROMPT, prompt);
  const citedRefs = extractCitations(answer);
  return {
    answer,
    references: dedupeReferences(
      citedRefs.length > 0 ? citedRefs : toReferences(chunks),
    ),
  };
}

/**
 * Function Explainer — same pipeline, scoped to one function/selection.
 */
async function explainFunction(repoId, filePath, codeSelection) {
  const prompt = `Explain what this code does, its inputs/outputs, and any side effects or edge cases. Be precise and concise.

File: ${filePath}
Code:\n${codeSelection}`;
  const answer = await callOllama(BASE_SYSTEM_PROMPT, prompt);
  return { answer, references: [{ filePath, startLine: null, endLine: null }] };
}

module.exports = {
  askQuestion,
  architectureSummary,
  interviewMode,
  findBugs,
  explainFunction,
};
