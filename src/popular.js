'use strict';

const { normalizeQuestion } = require('./normalize');

const MAX_TRACKED_CHARS = 200; // longer inputs are pasted text, not FAQ-style questions

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS question_stats (
    normalized     TEXT    PRIMARY KEY,           -- the question normalised (case, spacing, trailing punctuation)
    display        TEXT    NOT NULL,              -- the latest wording as typed, for showing
    times_asked    INTEGER NOT NULL DEFAULT 1,
    first_asked_at INTEGER NOT NULL,              -- ms since epoch
    last_asked_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_question_stats_rank ON question_stats (times_asked DESC, last_asked_at DESC);
`;

const UPSERT = `
  INSERT INTO question_stats (normalized, display, times_asked, first_asked_at, last_asked_at) VALUES (?, ?, 1, ?, ?)
  ON CONFLICT(normalized) DO UPDATE SET times_asked = times_asked + 1, display = excluded.display, last_asked_at = excluded.last_asked_at`;
const COUNT_ROWS = 'SELECT COUNT(*) AS n FROM question_stats';
const RANKING = 'ORDER BY times_asked DESC, last_asked_at DESC, normalized ASC'; // ties: the most recently asked first
const PRUNE = `DELETE FROM question_stats WHERE normalized IN (SELECT normalized FROM question_stats ${RANKING} LIMIT -1 OFFSET ?)`;
const TOP = `SELECT display AS question, times_asked AS count FROM question_stats WHERE times_asked >= ? ${RANKING} LIMIT ?`;

/**
 * Remembers how often each question is asked, in SQLite (table question_stats), so the list survives restarts.
 * Best-effort: a database problem makes record() return false and top() return [], it never breaks answering.
 *
 * @param db    from openDatabase() (src/db.js)
 * @param opts  { limit, minCount, cap, slack, now }  (`now` is injectable for tests)
 */
function createPopular(db, { limit = 2, minCount = 1, cap = 1000, slack = 100, now = Date.now } = {}) {
  db.exec(SCHEMA);
  let warnedAt = 0;
  const warn = (what, err) => {
    if (Date.now() - warnedAt < 30000) return; // don't flood the log
    warnedAt = Date.now();
    console.warn(`SQLite (${what}) failed; "Most asked" is paused: ${err.message}`);
  };

  return {
    enabled: true,

    /** Counts one ask. Returns true if it was stored. Never throws. */
    async record(question) {
      try {
        const member = normalizeQuestion(question);
        if (!member || question.trim().length > MAX_TRACKED_CHARS) return false;
        const display = question.replace(/\s+/g, ' ').trim();
        const at = now();
        db.transaction(() => {
          db.run(UPSERT, member, display, at, at);
          // keep the table bounded: once it outgrows cap (+ slack) drop the least-asked, oldest questions
          if (db.get(COUNT_ROWS).n > cap + slack) db.run(PRUNE, cap);
        });
        return true;
      } catch (err) {
        warn('record', err);
        return false;
      }
    },

    /** The most-asked questions, most asked first: [{question, count}]. Never throws. */
    top() {
      try {
        return Promise.resolve(db.all(TOP, minCount, limit));
      } catch (err) {
        warn('read', err);
        return Promise.resolve([]);
      }
    },
  };
}

/** Used when SQLite is switched off or unavailable: same shape, does nothing. */
function disabledPopular() {
  return { enabled: false, record: async () => false, top: async () => [] };
}

module.exports = { createPopular, disabledPopular, normalizeQuestion, MAX_TRACKED_CHARS };
