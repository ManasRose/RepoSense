// MODULE H — Feature Endpoints (API layer)
// Exposes REST endpoints wiring together Modules A-G.

const express = require("express");
const router = express.Router();

const { startIngestion, getStatus } = require("../modules/ingestion/pipeline");
const vectorstore = require("../modules/vectordb/vectorstore");
const orchestrator = require("../modules/orchestrator/orchestrate");
const { requireAuth, rateLimit } = require("../modules/auth/auth");
const { ChatHistory } = require("../modules/db/models");

// All feature routes require (lightweight/demo) auth + rate limiting
router.use(requireAuth);

/**
 * POST /api/repo/ingest
 * body: { repoUrl }
 * Kicks off A -> B -> C -> D -> E pipeline for a new repo.
 */
router.post("/repo/ingest", rateLimit, async (req, res) => {
  const { repoUrl } = req.body;
  if (!repoUrl || typeof repoUrl !== "string") {
    return res.status(400).json({ error: "repoUrl is required" });
  }

  try {
    const repoId = startIngestion(repoUrl);
    res
      .status(202)
      .json({
        repoId,
        status: "cloning",
        message: "Ingestion started. Poll /api/repo/:id/status.",
      });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/repo/:id/status
 * Ingestion progress — important for UX since indexing takes time.
 */
router.get("/repo/:id/status", async (req, res) => {
  const status = await getStatus(req.params.id);
  if (!status) return res.status(404).json({ error: "Unknown repoId" });
  res.json(status);
});

/**
 * POST /api/repo/:id/ask
 * body: { question }
 * question -> Retriever (F) -> LLM Orchestrator (G) -> answer
 */
router.post("/repo/:id/ask", rateLimit, async (req, res) => {
  const { id: repoId } = req.params;
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: "question is required" });
  if (!(await vectorstore.namespaceExists(repoId))) {
    return res
      .status(404)
      .json({
        error: "This repo hasn't been indexed yet. Check /status or re-ingest.",
      });
  }

  try {
    const result = await orchestrator.askQuestion(repoId, question);

    // best-effort chat history persistence (no-op if Mongo isn't connected)
    try {
      await ChatHistory.findOneAndUpdate(
        { repoId, userId: req.user.id === "demo-user" ? null : req.user.id },
        {
          $push: {
            messages: [
              { role: "user", content: question, references: [] },
              {
                role: "assistant",
                content: result.answer,
                references: result.references,
              },
            ],
          },
        },
        { upsert: true },
      );
    } catch {
      /* ignore if DB not connected */
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/repo/:id/interview-mode
 * body: { focusTopic? }
 */
router.post("/repo/:id/interview-mode", rateLimit, async (req, res) => {
  try {
    const result = await orchestrator.interviewMode(
      req.params.id,
      req.body.focusTopic,
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/repo/:id/architecture-summary
 */
router.post("/repo/:id/architecture-summary", rateLimit, async (req, res) => {
  try {
    const result = await orchestrator.architectureSummary(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/repo/:id/find-bugs
 * body: { focusPath? }
 */
router.post("/repo/:id/find-bugs", rateLimit, async (req, res) => {
  try {
    const result = await orchestrator.findBugs(
      req.params.id,
      req.body.focusPath,
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/repo/:id/explain-function
 * body: { filePath, code }
 * Takes a code selection, returns explanation.
 */
router.post("/repo/:id/explain-function", rateLimit, async (req, res) => {
  const { filePath, code } = req.body;
  if (!filePath || !code)
    return res.status(400).json({ error: "filePath and code are required" });

  try {
    const result = await orchestrator.explainFunction(
      req.params.id,
      filePath,
      code,
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/repo/:id/history
 * Fetch saved chat history for a repo (if DB connected).
 */
router.get("/repo/:id/history", async (req, res) => {
  try {
    const history = await ChatHistory.findOne({ repoId: req.params.id });
    res.json(history?.messages || []);
  } catch {
    res.json([]);
  }
});

module.exports = router;
