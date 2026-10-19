'use strict';
const { createLocalEmbedder } = require('./localEmbedder');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Pluggable model clients, chosen by config:
 *   generation: anthropic (Claude Messages API) | ollama (local /api/chat)
 *   embeddings: voyage (hosted API)             | local  (Hugging Face model in-process)
 * Both HTTP providers share one POST helper with a per-request timeout and retry with
 * exponential backoff on network errors, 429 and 5xx (not other 4xx).
 *
 * `deps.localEmbedderFactory` lets tests inject a fake local embedder.
 */
function createLLM(cfg, deps = {}) {
  async function postJson(label, url, headers, body) {
    let lastErr;
    for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
        if (res.ok) return await res.json();
        const text = await res.text();
        lastErr = new Error(`${label} failed: ${res.status} ${text.slice(0, 300)}`);
        if (res.status !== 429 && res.status < 500) throw Object.assign(lastErr, { fatal: true });
      } catch (err) {
        if (err.fatal) throw err;
        lastErr = err;
      }
      if (attempt < cfg.maxRetries) await sleep(500 * 2 ** attempt);
    }
    throw lastErr;
  }

  // ---- embeddings ----
  let localEmbedder; // lazily created promise
  const embedders = {
    /** Voyage distinguishes documents from queries via input_type. */
    async voyage(inputs, inputType) {
      const data = await postJson(
        'Voyage embeddings',
        `${cfg.voyageBaseUrl}/embeddings`,
        { Authorization: `Bearer ${cfg.voyageApiKey}` },
        { model: cfg.embeddingModel, input: inputs, input_type: inputType },
      );
      return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    },
    /** MiniLM-style models use the same encoding for queries and documents, so inputType is ignored. */
    async local(inputs) {
      localEmbedder ??= (deps.localEmbedderFactory || createLocalEmbedder)(cfg.embeddingModel);
      return (await localEmbedder)(inputs);
    },
  };

  // ---- generation ----
  const generators = {
    async anthropic(system, user) {
      const data = await postJson(
        'Anthropic messages',
        `${cfg.anthropicBaseUrl}/messages`,
        { 'x-api-key': cfg.anthropicApiKey, 'anthropic-version': '2023-06-01' },
        {
          // No `temperature`: newer Claude models reject it (400 "temperature is deprecated").
          model: cfg.chatModel,
          max_tokens: cfg.maxAnswerTokens,
          system,
          messages: [{ role: 'user', content: user }],
        },
      );
      return data.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    },
    async ollama(system, user) {
      const data = await postJson('Ollama chat', `${cfg.ollamaBaseUrl}/api/chat`, {}, {
        model: cfg.ollamaModel,
        stream: false,
        options: { temperature: 0, num_predict: cfg.maxAnswerTokens },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      });
      return data.message.content.trim();
    },
  };

  /** Startup checks so problems surface immediately with a useful message. */
  async function check() {
    if (cfg.llmProvider === 'ollama') {
      let tags;
      try {
        const res = await fetch(`${cfg.ollamaBaseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        tags = await res.json();
      } catch (err) {
        throw new Error(`Cannot reach Ollama at ${cfg.ollamaBaseUrl} (${err.message}). Is it running? Try: ollama serve`);
      }
      const names = (tags.models || []).map((m) => m.name);
      const want = cfg.ollamaModel;
      if (!names.includes(want) && !names.includes(`${want}:latest`)) {
        throw new Error(`Ollama model "${want}" is not installed. Run: ollama pull ${want} (installed: ${names.join(', ') || 'none'})`);
      }
    }
    if (cfg.embeddingProvider === 'local') {
      await embedders.local(['warm-up']); // loads (and on first run downloads) the model now, not on the first request
    }
  }

  return { embed: embedders[cfg.embeddingProvider], generate: generators[cfg.llmProvider], check };
}

module.exports = { createLLM };
