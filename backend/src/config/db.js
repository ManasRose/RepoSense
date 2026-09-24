const mongoose = require("mongoose");

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[db] MONGODB_URI not set — skipping DB connection (demo mode, in-memory only).");
    return null;
  }
  try {
    await mongoose.connect(uri);
    console.log("[db] MongoDB connected");
    return mongoose.connection;
  } catch (err) {
    console.error("[db] MongoDB connection failed:", err.message);
    return null;
  }
}

module.exports = { connectDB };
