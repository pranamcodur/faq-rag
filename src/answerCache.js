'use strict';
const { normalizeQuestion } = require('./normalize');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS answer_cache (
    fingerprint TEXT    NOT NULL,   -- which FAQ content + models + settings produced the answer (see rag.js)
    top_k       INTEGER NOT NULL,
    normalized  TEXT    NOT NULL,   -- the question normalised (case, spacing, trailing punctuation)
    question    TEXT    NOT NULL,   -- as first typed, for humans reading the table
    answer      TEXT    NOT NULL,
    sources     TEXT    NOT NULL,   -- JSON array of file names
    created_at  INTEGER NOT NULL,   -- ms since epoch
    last_hit_at INTEGER NOT NULL,
    hits        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (fingerprint, top_k, normalized)
  );
  CREATE INDEX IF NOT EXISTS idx_answer_cache_lru ON answer_cache (last_hit_at);
`;

const KEY = 'fingerprint = ? AND top_k = ? AND normalized = ?';
const SELECT = `SELECT answer, sources, created_at FROM answer_cache WHERE ${KEY}`;
const DELETE_ONE = `DELETE FROM answer_cache WHERE ${KEY}`;
const TOUCH = `UPDATE answer_cache SET hits = hits + 1, last_hit_at = ? WHERE ${KEY}`;
const UPSERT = `
  INSERT INTO answer_cache (fingerprint, top_k, normalized, question, answer, sources, created_at, last_hit_at, hits)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
  ON CONFLICT(fingerprint, top_k, normalized) DO UPDATE SET
    question = excluded.question, answer = excluded.answer, sources = excluded.sources,
    created_at = excluded.created_at, last_hit_at = excluded.last_hit_at, hits = 0`;
const COUNT_ROWS = 'SELECT COUNT(*) AS n FROM answer_cache';
const PRUNE = 'DELETE FROM answer_cache WHERE rowid IN (SELECT rowid FROM answer_cache ORDER BY last_hit_at DESC LIMIT -1 OFFSET ?)';

/**
 * Remembers full answers, so a repeated question skips retrieval and the (slow) chat model.
 *
 * An answer is only valid for the exact FAQ content, models and settings that produced it, so every entry carries
 * a `fingerprint` (computed by rag.js) and is looked up under the CURRENT fingerprint only: edit a FAQ file,
 * change the model or the prompt, and old entries simply stop matching (and are purged on the next index build).
 *
 * Best-effort, like the rest of the SQLite features: a database problem makes get() miss and put() do nothing.
 *
 * @param db    from openDatabase() (src/db.js)
 * @param opts  { ttlMs (0 = never expires), cap, slack, now }
 */
function createAnswerCache(db, { ttlMs = 7 * 24 * 3600 * 1000, cap = 1000, slack = 100, now = Date.now } = {}) {
  db.exec(SCHEMA);
  let warnedAt = 0;
  const warn = (what, err) => {
    if (Date.now() - warnedAt < 30000) return;
    warnedAt = Date.now();
    console.warn(`SQLite (answer cache ${what}) failed; answers are not being cached: ${err.message}`);
  };

  return {
    /** @returns {{answer:string, sources:string[]} | null} Never throws. */
    get(fingerprint, topK, question) {
      try {
        const key = normalizeQuestion(question);
        if (!key) return null;
        const row = db.get(SELECT, fingerprint, topK, key);
        if (!row) return null;
        const at = now();
        if (ttlMs && at - row.created_at > ttlMs) { // too old: don't serve a frozen answer forever
          db.run(DELETE_ONE, fingerprint, topK, key);
          return null;
        }
        const sources = JSON.parse(row.sources);
        if (!Array.isArray(sources)) return null;
        db.run(TOUCH, at, fingerprint, topK, key);
        return { answer: row.answer, sources };
      } catch (err) {
        warn('read', err);
        return null;
      }
    },

    /** Stores (or refreshes) an answer. Returns true if stored. Never throws. */
    put(fingerprint, topK, question, { answer, sources }) {
      try {
        const key = normalizeQuestion(question);
        if (!key) return false;
        const at = now();
        db.transaction(() => {
          db.run(UPSERT, fingerprint, topK, key, question.trim(), answer, JSON.stringify(sources), at, at);
          if (db.get(COUNT_ROWS).n > cap + slack) db.run(PRUNE, cap); // keep the most recently used
        });
        return true;
      } catch (err) {
        warn('write', err);
        return false;
      }
    },

    /** Drops every entry that doesn't belong to the current fingerprint. Never throws. */
    retain(fingerprint) {
      try {
        return db.run('DELETE FROM answer_cache WHERE fingerprint <> ?', fingerprint).changes;
      } catch (err) {
        warn('cleanup', err);
        return 0;
      }
    },
  };
}

module.exports = { createAnswerCache };
