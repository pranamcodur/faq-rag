'use strict';

/**
 * Local sentence embeddings via Hugging Face transformers.js (ONNX, runs on CPU in Node).
 * The package is loaded lazily so the hosted-provider setup needs no npm install.
 * The first run downloads the model from the Hugging Face Hub (~25 MB for MiniLM) and caches it;
 * after that it works offline.
 *
 * Returns an async function: string[] -> number[][] (mean-pooled, L2-normalised vectors).
 */
async function createLocalEmbedder(modelName) {
  let transformers;
  try {
    transformers = await import('@huggingface/transformers');
  } catch (err) {
    throw new Error('EMBEDDING_PROVIDER=local needs the "@huggingface/transformers" package. Run: npm install');
  }
  const extractor = await transformers.pipeline('feature-extraction', modelName);
  return async (texts) => {
    const out = await extractor(texts, { pooling: 'mean', normalize: true });
    return out.tolist();
  };
}

module.exports = { createLocalEmbedder };
