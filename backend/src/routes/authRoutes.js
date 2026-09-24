const express = require("express");
const router = express.Router();
const { signup, login } = require("../modules/auth/auth");

router.post("/signup", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "email and password required" });
  try {
    const { user, token } = await signup(email, password);
    res.status(201).json({ user: { id: user._id, email: user.email }, token });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "email and password required" });
  try {
    const { user, token } = await login(email, password);
    res.json({ user: { id: user._id, email: user.email }, token });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

module.exports = router;
