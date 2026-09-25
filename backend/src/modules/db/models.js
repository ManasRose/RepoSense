// MODULE J — MongoDB (Metadata Layer)
// Stores everything that isn't a vector: repo metadata, chat history, users.

const mongoose = require("mongoose");

const RepoSchema = new mongoose.Schema(
  {
    repoUrl: { type: String, required: true },
    repoId: { type: String, required: true, unique: true }, // stable hash/id used to namespace vectors
    ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    status: {
      type: String,
      enum: ["pending", "cloning", "parsing", "embedding", "ready", "failed"],
      default: "pending",
    },
    error: { type: String, default: null },
    fileCount: { type: Number, default: 0 },
    chunkCount: { type: Number, default: 0 },
    indexedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

const ChatMessageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ["user", "assistant"], required: true },
    content: { type: String, required: true },
    references: [
      {
        filePath: String,
        startLine: Number,
        endLine: Number,
      },
    ],
  },
  { timestamps: true }
);

const ChatHistorySchema = new mongoose.Schema(
  {
    repoId: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    messages: [ChatMessageSchema],
  },
  { timestamps: true }
);

const UserSchema = new mongoose.Schema(
  {
    githubId: { type: String, unique: true, sparse: true },
    email: { type: String, unique: true, sparse: true },
    name: { type: String },
    passwordHash: { type: String }, // only used if not using GitHub OAuth
  },
  { timestamps: true }
);

const Repo = mongoose.model("Repo", RepoSchema);
const ChatHistory = mongoose.model("ChatHistory", ChatHistorySchema);
const User = mongoose.model("User", UserSchema);

module.exports = { Repo, ChatHistory, User };
