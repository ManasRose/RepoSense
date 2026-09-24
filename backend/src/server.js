require("dotenv").config();
const express = require("express");
const cors = require("cors");

const { connectDB } = require("./config/db");
const repoRoutes = require("./routes/repoRoutes");
const authRoutes = require("./routes/authRoutes");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors()); // in production, lock this down to your extension's origin
app.use(express.json({ limit: "2mb" }));

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api", repoRoutes);

// centralized error handler (catches anything thrown outside try/catch in routes)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

async function start() {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`GitHub Repo Intelligence backend running on http://localhost:${PORT}`);
    if (!process.env.AUTH_ENABLED || process.env.AUTH_ENABLED !== "true") {
      console.log(`[auth] Running in DEMO MODE (no auth). Set AUTH_ENABLED=true in .env to require login.`);
    }
  });
}

start();

module.exports = app;
