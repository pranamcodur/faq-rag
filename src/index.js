'use strict';
const { loadConfig } = require('./config');
const { createLLM } = require('./llm');
const { createRag } = require('./rag');
const { createServer } = require('./app');
const { openDatabase } = require('./db');
const { createPopular, disabledPopular } = require('./popular');
const { createAnswerCache } = require('./answerCache');
const { createVectorStore } = require('./vectorStore');

async function main() {
  const cfg = loadConfig(); // throws if an API key is missing -> fail fast
  const llm = createLLM(cfg);

  // SQLite is optional: it backs the "Most asked" list and the answer cache. Without it the app works as before.
  let popular = disabledPopular();
  let cache = null;
  let store = null;
  if (cfg.sqlitePath) {
    try {
      const wantsVec = cfg.vectorStore === 'auto' || cfg.vectorStore === 'sqlite-vec';
      const db = openDatabase(cfg.sqlitePath, { driver: cfg.sqliteDriver, allowExtensions: wantsVec });
      process.on('exit', () => { try { db.close(); } catch { /* already closed */ } });
      popular = createPopular(db, { limit: cfg.popularLimit, minCount: cfg.popularMinCount });
      if (cfg.answerCache) {
        cache = createAnswerCache(db, { ttlMs: cfg.answerCacheTtlHours * 3600 * 1000, cap: cfg.answerCacheMaxEntries });
      }
      if (cfg.vectorStore !== 'memory') {
        store = await createVectorStore(db, { mode: cfg.vectorStore === 'sqlite' ? 'sqlite' : 'auto' });
        console.log(store.mode === 'sqlite-vec'
          ? `Vector store: SQLite + sqlite-vec ${store.vecVersion} (vectors are saved in the database and searched inside SQLite)`
          : `Vector store: SQLite (vectors are saved in the database and searched in Node${store.fallbackReason ? `; sqlite-vec not used: ${store.fallbackReason}` : ''})`);
      }
      console.log(`SQLite: ${cfg.sqlitePath} (driver: ${db.driver}) | most asked: on | answer cache: ${cache ? `on, entries expire after ${cfg.answerCacheTtlHours ? `${cfg.answerCacheTtlHours}h` : 'never'}` : 'off'}`);
    } catch (err) {
      console.warn(`SQLite is not available, so "Most asked", the answer cache and saved vectors are off: ${err.message}`);
    }
  } else if (cfg.answerCache) {
    console.log('SQLite is off (SQLITE_PATH), so the answer cache is off too.');
  }

  if (!store) console.log('Vector store: in memory only (rebuilt at every start)');
  const rag = createRag(cfg, llm, { cache, store });

  const gen = cfg.llmProvider === 'ollama' ? `ollama (${cfg.ollamaModel})` : `anthropic (${cfg.chatModel})`;
  console.log(`Answers: ${gen} | Embeddings: ${cfg.embeddingProvider} (${cfg.embeddingModel})`);
  if (cfg.embeddingProvider === 'local') console.log('Loading local embedding model (first run downloads it) ...');
  await llm.check();

  console.log(`Indexing FAQs from ${cfg.faqDir} ...`);
  const stats = await rag.ingest();
  console.log(`Indexed ${stats.chunks} chunks from ${stats.files} files${store ? ` (${stats.embedded} embedded, ${stats.reused} reused from SQLite)` : ''}`);

  createServer(rag, cfg, popular).listen(cfg.port, () => console.log(`Ready: open http://localhost:${cfg.port} in your browser (API: POST /ask)`));
}

main().catch((err) => {
  console.error('Startup failed:', err.message);
  process.exit(1);
});
