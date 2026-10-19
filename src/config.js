'use strict';
const path = require('node:path');

const LLM_PROVIDERS = ['anthropic', 'ollama'];
const EMBEDDING_PROVIDERS = ['voyage', 'local'];
const DECOMPOSITION_MODES = ['auto', 'off', 'always'];
const SQLITE_DRIVERS = ['auto', 'better-sqlite3', 'node'];
const ON_OFF = ['on', 'off'];
const VECTOR_STORES = ['auto', 'sqlite-vec', 'sqlite', 'memory'];

const int = (env, name, dflt) => {
  const raw = env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Env var ${name} must be a positive integer (got "${raw}")`);
  return n;
};

const nonNegativeInt = (env, name, dflt) => {
  const raw = env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Env var ${name} must be a whole number, 0 or more (got "${raw}")`);
  return n;
};

const oneOf = (env, name, allowed, dflt) => {
  const v = (env[name] || dflt).toLowerCase();
  if (!allowed.includes(v)) throw new Error(`${name} must be one of: ${allowed.join(', ')} (got "${v}")`);
  return v;
};

const need = (env, key, why) => {
  if (!env[key]) throw new Error(`${key} is not set (required ${why}). Copy .env.example to .env and set it (see README).`);
  return env[key];
};

const trim = (u) => u.replace(/\/$/, '');

function sqlitePath(env) {
  const raw = (env.SQLITE_PATH || './data/faq-rag.db').trim();
  if (['off', 'false', '0', 'none'].includes(raw.toLowerCase())) return null;
  return raw === ':memory:' ? raw : path.resolve(raw);
}

/** Reads config from env. Throws (fail fast) on invalid values or on a missing key the chosen providers need. */
function loadConfig(env = process.env) {
  const llmProvider = oneOf(env, 'LLM_PROVIDER', LLM_PROVIDERS, 'anthropic');
  const embeddingProvider = oneOf(env, 'EMBEDDING_PROVIDER', EMBEDDING_PROVIDERS, 'voyage');

  return {
    llmProvider,
    embeddingProvider,
    // keys only when that provider is selected
    anthropicApiKey: llmProvider === 'anthropic' ? need(env, 'ANTHROPIC_API_KEY', 'when LLM_PROVIDER=anthropic') : undefined,
    voyageApiKey: embeddingProvider === 'voyage' ? need(env, 'VOYAGE_API_KEY', 'when EMBEDDING_PROVIDER=voyage') : undefined,
    anthropicBaseUrl: trim(env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1'),
    voyageBaseUrl: trim(env.VOYAGE_BASE_URL || 'https://api.voyageai.com/v1'),
    ollamaBaseUrl: trim(env.OLLAMA_BASE_URL || 'http://localhost:11434'),
    ollamaModel: env.OLLAMA_MODEL || 'llama3.1:8b',
    chatModel: env.CHAT_MODEL || 'claude-haiku-5-5',
    embeddingModel: env.EMBEDDING_MODEL || (embeddingProvider === 'local' ? 'Xenova/all-MiniLM-L6-v2' : 'voyage-3.5-lite'),
    maxAnswerTokens: int(env, 'MAX_ANSWER_TOKENS', 500),
    // "Most asked" list, stored in a SQLite file. SQLITE_PATH=off turns it off; ':memory:' keeps it in RAM only.
    sqlitePath: sqlitePath(env),
    sqliteDriver: oneOf(env, 'SQLITE_DRIVER', SQLITE_DRIVERS, 'auto'),
    popularLimit: Math.min(int(env, 'POPULAR_LIMIT', 2), 10),
    popularMinCount: int(env, 'POPULAR_MIN_COUNT', 1),
    // Where chunk vectors live. auto/sqlite-vec: saved in SQLite and searched by the sqlite-vec extension when it is available;
    // sqlite: saved in SQLite but searched in Node; memory: kept in RAM only and rebuilt at every start. Needs SQLite unless 'memory'.
    vectorStore: oneOf(env, 'VECTOR_STORE', VECTOR_STORES, 'auto'),
    // Answer cache (needs SQLite): repeated questions skip retrieval and the chat model. Entries expire after the TTL (0 = never).
    answerCache: oneOf(env, 'ANSWER_CACHE', ON_OFF, 'on') === 'on',
    answerCacheTtlHours: nonNegativeInt(env, 'ANSWER_CACHE_TTL_HOURS', 168),
    answerCacheMaxEntries: int(env, 'ANSWER_CACHE_MAX_ENTRIES', 1000),
    // splitting multi-part questions into sub-questions: auto = only when the question looks compound
    decomposition: oneOf(env, 'QUERY_DECOMPOSITION', DECOMPOSITION_MODES, 'auto'),
    faqDir: path.resolve(env.FAQ_DIR || './faqs'),
    port: int(env, 'PORT', 3000),
    chunkSize: int(env, 'CHUNK_SIZE', 200),
    chunkOverlap: int(env, 'CHUNK_OVERLAP', 30),
    defaultTopK: int(env, 'DEFAULT_TOP_K', 4),
    maxTopK: int(env, 'MAX_TOP_K', 10),
    // local models are slower than hosted APIs, so allow more time by default
    timeoutMs: int(env, 'REQUEST_TIMEOUT_MS', llmProvider === 'ollama' ? 120000 : 30000),
    maxRetries: Number(env.MAX_RETRIES ?? 2),
  };
}

module.exports = { loadConfig };
