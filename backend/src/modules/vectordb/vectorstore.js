// MODULE E — Vector DB Layer (Chroma-backed)
const { ChromaClient } = require("chromadb");

const client = new ChromaClient({
  path: process.env.CHROMA_URL || "http://localhost:8000",
});

function collectionName(repoId) {
  return `repo_${repoId}`; // satisfies Chroma's naming rules
}

async function getCollection(repoId) {
  return client.getOrCreateCollection({
    name: collectionName(repoId),
    metadata: { "hnsw:space": "cosine" }, // match old cosine-similarity behavior
  });
}

async function upsert(repoId, chunks, vectors) {
  const vectorMap = new Map(vectors.map((v) => [v.chunkId, v.vector]));
  const collection = await getCollection(repoId);

  const toAdd = chunks.filter((c) => vectorMap.has(c.chunkId));
  if (toAdd.length === 0) return { upserted: 0 };

  await collection.upsert({
    ids: toAdd.map((c) => c.chunkId),
    embeddings: toAdd.map((c) => vectorMap.get(c.chunkId)),
    documents: toAdd.map((c) => c.text),
    metadatas: toAdd.map((c) => ({ filePath: c.filePath, ...c.metadata })),
  });

  const count = await collection.count();
  return { upserted: toAdd.length, total: count };
}

async function query(repoId, queryVector, topK = 8) {
  const collection = await getCollection(repoId);
  const results = await collection.query({
    queryEmbeddings: [queryVector],
    nResults: topK,
  });

  // Chroma returns parallel arrays, one per queryEmbedding (we only sent one, so index [0])
  const ids = results.ids[0];
  const docs = results.documents[0];
  const metas = results.metadatas[0];
  const distances = results.distances[0]; // lower = more similar, for cosine space

  return ids.map((chunkId, i) => ({
    chunkId,
    filePath: metas[i].filePath,
    text: docs[i],
    metadata: metas[i],
    score: 1 - distances[i], // convert distance back to a similarity score like before
  }));
}

async function clearNamespace(repoId) {
  try {
    await client.deleteCollection({ name: collectionName(repoId) });
  } catch {
    // collection didn't exist — fine
  }
}

async function namespaceExists(repoId) {
  try {
    const collection = await client.getCollection({
      name: collectionName(repoId),
    });
    const count = await collection.count();
    return count > 0;
  } catch {
    return false; // collection doesn't exist yet
  }
}

module.exports = { upsert, query, clearNamespace, namespaceExists };
