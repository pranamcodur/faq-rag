'use strict';

/**
 * Keeps the FAQ chunks and their embedding vectors in SQLite, so they survive restarts and only changed FAQ files are
 * embedded again. When the sqlite-vec extension is available it also does the nearest-neighbour search inside SQLite;
 * otherwise the app searches in memory as before, using the same saved data.
 *
 * Tables:  faq_files (file, hash)  ·  faq_chunks (id, file, ord, text, embedding BLOB)  ·  vector_meta (key, value)
 *          faq_chunk_vec  (sqlite-vec `vec0` virtual table, rowid = faq_chunks.id)  <- only when sqlite-vec is active
 *
 * Vectors are stored L2-normalised as float32. For unit vectors, cosine similarity = 1 - distance^2 / 2, so sqlite-vec's
 * default (Euclidean) distance gives exactly the cosine ranking the app already used.
 */
const SEARCH_LIMIT = 1000; // most chunks one search returns; beyond this, ranking is by the 1000 nearest

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS vector_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS faq_files  (file TEXT PRIMARY KEY, hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS faq_chunks (
    id        INTEGER PRIMARY KEY,
    file      TEXT    NOT NULL,
    ord       INTEGER NOT NULL,            -- position of the chunk within its file
    text      TEXT    NOT NULL,
    embedding BLOB    NOT NULL,            -- float32, L2-normalised
    UNIQUE (file, ord)
  );
`;

const firstLine = (s) => String(s).split('\n')[0];
const normalize = (v) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); };
const toBlob = (v) => { const f = Float32Array.from(v); return Buffer.from(f.buffer, f.byteOffset, f.byteLength); };
const fromBlob = (b) => Array.from(new Float32Array(Uint8Array.from(b).buffer)); // copy first: a blob's byte offset may not be 4-aligned
// sqlite-vec needs INTEGER row ids; drivers bind plain JS numbers as floating point, so ids are passed as BigInt
const rowid = (n) => BigInt(n);

const defaultLoadSqliteVec = () => import('sqlite-vec');

/** Loads sqlite-vec into the connection and proves it works before the app relies on it. Throws a readable error if not. */
async function enableSqliteVec(db, loadSqliteVec) {
  const mod = await loadSqliteVec();
  const api = mod && typeof mod.getLoadablePath === 'function' ? mod : mod && mod.default;
  if (!api || typeof api.getLoadablePath !== 'function') throw new Error('the sqlite-vec package has no getLoadablePath()');
  db.loadExtension(api.getLoadablePath());
  const version = db.get('SELECT vec_version() AS v').v;

  // self-test: two known vectors, one nearest-neighbour query, check the answer
  db.exec('DROP TABLE IF EXISTS vec_selftest');
  db.exec('CREATE VIRTUAL TABLE vec_selftest USING vec0(embedding float[3])');
  try {
    db.run('INSERT INTO vec_selftest(rowid, embedding) VALUES (?, ?)', rowid(1), toBlob([1, 0, 0]));
    db.run('INSERT INTO vec_selftest(rowid, embedding) VALUES (?, ?)', rowid(2), toBlob([0, 1, 0]));
    const rows = db.all('SELECT rowid, distance FROM vec_selftest WHERE embedding MATCH ? AND k = 2 ORDER BY distance', toBlob([1, 0, 0]));
    const ok = rows.length === 2 && Number(rows[0].rowid) === 1 && Math.abs(rows[0].distance) < 1e-4 && Math.abs(rows[1].distance - Math.SQRT2) < 1e-3;
    if (!ok) throw new Error(`sqlite-vec self-test returned unexpected results: ${JSON.stringify(rows)}`);
  } finally {
    db.exec('DROP TABLE IF EXISTS vec_selftest');
  }
  return version;
}

/**
 * @param db    from openDatabase() (src/db.js); opened with allowExtensions: true if sqlite-vec is wanted
 * @param opts  { mode: 'auto' | 'sqlite' ('sqlite' = never try sqlite-vec), loadSqliteVec, log }
 */
async function createVectorStore(db, { mode = 'auto', loadSqliteVec = defaultLoadSqliteVec, log = console } = {}) {
  db.exec(SCHEMA);

  let native = false;
  let vecVersion = null;
  let fallbackReason = null;
  let vecReady = false; // the vec0 table exists, matches the saved chunks, and is being kept in step
  if (mode !== 'sqlite') {
    try {
      vecVersion = await enableSqliteVec(db, loadSqliteVec);
      native = true;
    } catch (err) {
      fallbackReason = firstLine(err.message);
    } finally {
      // whether or not sqlite-vec loaded, nothing else should be able to load extensions into this connection
      try { db.disableExtensionLoading?.(); } catch { /* nothing to switch off */ }
    }
  }

  const readMeta = () => Object.fromEntries(db.all('SELECT key, value FROM vector_meta').map((r) => [r.key, r.value]));
  const setMeta = (key, value) => db.run('INSERT INTO vector_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
  const vecTableExists = () => Boolean(db.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'faq_chunk_vec'"));

  /** Makes sure the vec0 table exists for `dims` and holds every saved chunk (rebuilt from faq_chunks if it was missing, stale or a different size). */
  function ensureVecTable(dims) {
    const meta = readMeta();
    if (vecTableExists() && meta.vec_synced === '1' && meta.vec_dims === String(dims)) return;
    db.exec('DROP TABLE IF EXISTS faq_chunk_vec');
    db.exec(`CREATE VIRTUAL TABLE faq_chunk_vec USING vec0(embedding float[${Number(dims)}])`);
    for (const r of db.all('SELECT id, embedding FROM faq_chunks')) db.run('INSERT INTO faq_chunk_vec(rowid, embedding) VALUES (?, ?)', rowid(r.id), r.embedding);
    setMeta('vec_synced', '1');
    setMeta('vec_dims', dims);
  }

  function removeFile(file) {
    const ids = db.all('SELECT id FROM faq_chunks WHERE file = ?', file).map((r) => r.id);
    if (native && vecReady) for (const id of ids) db.run('DELETE FROM faq_chunk_vec WHERE rowid = ?', rowid(id));
    db.run('DELETE FROM faq_chunks WHERE file = ?', file);
    db.run('DELETE FROM faq_files WHERE file = ?', file);
  }

  const store = {
    /** 'sqlite-vec' while searches run inside SQLite, 'sqlite' when only saving there and searching in Node. */
    get mode() { return native ? 'sqlite-vec' : 'sqlite'; },
    get vecVersion() { return vecVersion; },
    get fallbackReason() { return fallbackReason; },

    /**
     * What was saved for these settings: Map(file -> { hash, chunks: [{ text, embedding }] }), in chunk order.
     * Empty if nothing was saved, or it was saved with different settings (different embedding model or chunking).
     */
    load(settingsKey) {
      const out = new Map();
      if (readMeta().settings_key !== settingsKey) return out;
      for (const f of db.all('SELECT file, hash FROM faq_files')) out.set(f.file, { hash: f.hash, chunks: [] });
      for (const r of db.all('SELECT file, ord, text, embedding FROM faq_chunks ORDER BY file, ord')) {
        const entry = out.get(r.file);
        if (entry) entry.chunks.push({ text: r.text, embedding: fromBlob(r.embedding) });
      }
      return out;
    },

    /**
     * Makes the database match `files` ([{ file, hash, chunks: [{ text, embedding }] }]) in one transaction: files whose hash is
     * unchanged are left alone; changed, removed and new files are rewritten. Returns Map(file -> [row id per chunk, in order]).
     * If anything fails nothing is changed.
     */
    save(settingsKey, files) {
      const dims = files.flatMap((f) => f.chunks)[0]?.embedding.length ?? null;
      return db.transaction(() => {
        const meta = readMeta();
        if (meta.settings_key !== settingsKey || (dims !== null && meta.dimensions !== String(dims))) {
          db.run('DELETE FROM faq_chunks');
          db.run('DELETE FROM faq_files');
          if (native && vecTableExists()) db.exec('DROP TABLE IF EXISTS faq_chunk_vec');
          setMeta('settings_key', settingsKey);
          if (dims !== null) setMeta('dimensions', dims);
          setMeta('vec_synced', '0');
        }

        if (native && dims !== null) { ensureVecTable(dims); vecReady = true; }
        else { setMeta('vec_synced', '0'); vecReady = false; } // can't keep the vec table in step: rebuilt when sqlite-vec is next used

        const stored = new Map(db.all('SELECT file, hash FROM faq_files').map((r) => [r.file, r.hash]));
        const wanted = new Map(files.map((f) => [f.file, f]));
        for (const [file, hash] of stored) {
          if (!wanted.has(file) || wanted.get(file).hash !== hash) { removeFile(file); stored.delete(file); }
        }

        let nextId = db.get('SELECT COALESCE(MAX(id), 0) AS m FROM faq_chunks').m + 1;
        for (const f of files) {
          if (stored.has(f.file)) continue; // unchanged: keep its saved chunks and vectors
          db.run('INSERT INTO faq_files (file, hash) VALUES (?, ?)', f.file, f.hash);
          f.chunks.forEach((c, ord) => {
            const id = nextId++;
            const blob = toBlob(normalize(c.embedding));
            db.run('INSERT INTO faq_chunks (id, file, ord, text, embedding) VALUES (?, ?, ?, ?, ?)', rowid(id), f.file, ord, c.text, blob);
            if (native && vecReady) db.run('INSERT INTO faq_chunk_vec(rowid, embedding) VALUES (?, ?)', rowid(id), blob);
          });
        }

        const ids = new Map();
        for (const r of db.all('SELECT id, file FROM faq_chunks ORDER BY file, ord')) {
          if (!ids.has(r.file)) ids.set(r.file, []);
          ids.get(r.file).push(Number(r.id));
        }
        return ids;
      });
    },

    /**
     * Nearest chunks to `qVec` by cosine similarity, best first: [{ rowid, score }]. Returns null when SQLite is not doing the
     * searching (not available, or it failed), and the caller searches in memory instead. Never throws.
     */
    search(qVec, limit) {
      if (!native || !vecReady) return null;
      try {
        const n = Math.min(Math.max(1, Math.floor(limit)), SEARCH_LIMIT);
        // k is written into the SQL as an integer literal: the one number sqlite-vec is picky about binding
        const rows = db.all(`SELECT rowid, distance FROM faq_chunk_vec WHERE embedding MATCH ? AND k = ${n} ORDER BY distance`, toBlob(normalize(qVec)));
        return rows.map((r) => ({ rowid: Number(r.rowid), score: 1 - (r.distance * r.distance) / 2 }));
      } catch (err) {
        native = false;
        fallbackReason = `search failed: ${firstLine(err.message)}`;
        log.warn(`sqlite-vec search failed, searching in memory from now on: ${firstLine(err.message)}`);
        return null;
      }
    },
  };
  return store;
}

module.exports = { createVectorStore, SEARCH_LIMIT };
