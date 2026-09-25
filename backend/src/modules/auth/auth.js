// MODULE I — Auth & User Layer
// Simple JWT auth. If AUTH_ENABLED=false (demo mode), all requests pass through
// as an anonymous shared user — matches the plan's "cut auth first" scope note.

const jwt = (() => {
  try { return require("jsonwebtoken"); } catch { return null; }
})();
const { User } = require("../db/models");

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const AUTH_ENABLED = process.env.AUTH_ENABLED === "true";

function signToken(user) {
  if (!jwt) throw new Error("jsonwebtoken not installed. Run: npm install jsonwebtoken");
  return jwt.sign({ id: user._id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
}

/**
 * Express middleware: attaches req.user if a valid token is present.
 * In demo mode (AUTH_ENABLED=false), always attaches a shared anonymous user.
 */
function requireAuth(req, res, next) {
  if (!AUTH_ENABLED) {
    req.user = { id: "demo-user", email: "demo@local" };
    return next();
  }

  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing auth token" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/**
 * Basic email/password signup — used only if not using GitHub OAuth.
 */
async function signup(email, password) {
  const bcrypt = require("bcryptjs");
  const existing = await User.findOne({ email });
  if (existing) throw new Error("Email already in use");
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ email, passwordHash });
  return { user, token: signToken(user) };
}

async function login(email, password) {
  const bcrypt = require("bcryptjs");
  const user = await User.findOne({ email });
  if (!user) throw new Error("Invalid credentials");
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw new Error("Invalid credentials");
  return { user, token: signToken(user) };
}

/**
 * Very simple per-user rate limiter (in-memory) to cap LLM API cost.
 * For production, swap for Redis-backed limiter.
 */
const requestCounts = new Map(); // userId -> { count, resetAt }
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 30); // requests
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60 * 60 * 1000); // 1 hour

function rateLimit(req, res, next) {
  const userId = req.user?.id || "anonymous";
  const now = Date.now();
  const entry = requestCounts.get(userId);

  if (!entry || now > entry.resetAt) {
    requestCounts.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return next();
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return res.status(429).json({ error: "Rate limit exceeded. Try again later." });
  }

  entry.count += 1;
  next();
}

module.exports = { requireAuth, rateLimit, signup, login, signToken };
