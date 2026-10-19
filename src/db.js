'use strict';
const fs = require('node:fs');
const path = require('node:path');

/**
 * One tiny SQLite interface over two drivers, so the app works wherever it is installed:
 *   better-sqlite3  the usual npm package (native addon with prebuilt binaries); listed as an optionalDependency
 *   node:sqlite     built into Node 22.5+, no install needed
 * `auto` tries better-sqlite3 first, then node:sqlite. Only methods both drivers share are used
 * (prepare/run/get/all, exec, close) with positional `?` parameters, so behaviour is identical.
 *
 * `opts.allowExtensions` lets the connection load extensions (needed for sqlite-vec); `opts.loaders` lets tests inject drivers.
 */
const defaultLoaders = {
  betterSqlite3: () => require('better-sqlite3'),
  nodeSqlite: () => require('node:sqlite'),
};

const firstLine = (s) => String(s).split('\n')[0];

function pickDriver(preference, loaders) {
  const candidates = {
    'better-sqlite3': () => { const Database = loaders.betterSqlite3(); return { name: 'better-sqlite3', open: (file) => new Database(file) }; }, // loadExtension is always available
    node: () => {
      const { DatabaseSync } = loaders.nodeSqlite();
      // node:sqlite only allows loading extensions (such as sqlite-vec) when asked at open time (Node 22.13+)
      return { name: 'node:sqlite', open: (file, o) => (o.allowExtensions ? new DatabaseSync(file, { allowExtension: true }) : new DatabaseSync(file)) };
    },
  };
  const order = preference === 'auto' ? ['better-sqlite3', 'node'] : [preference];
  const problems = [];
  for (const key of order) {
    try { return candidates[key](); } catch (err) { problems.push(`${key === 'node' ? 'node:sqlite' : key}: ${firstLine(err.message)}`); }
  }
  throw new Error(`No SQLite driver available (${problems.join('; ')}). Run "npm install" to get better-sqlite3, or use Node 22.5+ which has SQLite built in.`);
}

/** Opens (creating if needed) a SQLite database. `file` may be ':memory:'. */
function openDatabase(file, opts = {}) {
  const driver = pickDriver(opts.driver || 'auto', opts.loaders || defaultLoaders);
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = driver.open(file, { allowExtensions: Boolean(opts.allowExtensions) });

  try {
    raw.exec('PRAGMA busy_timeout = 2000');
    if (file !== ':memory:') raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL');
  } catch (err) {
    raw.close();
    throw err;
  }

  const statements = new Map();
  const stmt = (sql) => {
    let s = statements.get(sql);
    if (!s) { s = raw.prepare(sql); statements.set(sql, s); }
    return s;
  };
  const plain = (row) => (row ? { ...row } : undefined); // node:sqlite rows have a null prototype

  return {
    driver: driver.name,
    file,
    exec: (sql) => { raw.exec(sql); },
    run: (sql, ...params) => ({ changes: Number(stmt(sql).run(...params).changes) }),
    get: (sql, ...params) => plain(stmt(sql).get(...params)),
    all: (sql, ...params) => stmt(sql).all(...params).map(plain),
    /** Runs fn inside one transaction: all of it is saved, or none of it. */
    transaction(fn) {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        raw.exec('COMMIT');
        return result;
      } catch (err) {
        try { raw.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw err;
      }
    },
    /** Loads a SQLite extension (e.g. sqlite-vec). Extension loading is switched off again afterwards where the driver allows it. */
    loadExtension(extensionPath) {
      if (typeof raw.loadExtension !== 'function') throw new Error('this SQLite driver cannot load extensions (use better-sqlite3, or Node 22.13+)');
      raw.loadExtension(extensionPath);
      if (typeof raw.enableLoadExtension === 'function') raw.enableLoadExtension(false);
    },
    /** Switches extension loading off again (a no-op for drivers without such a switch). Safe to call any time. */
    disableExtensionLoading() {
      if (typeof raw.enableLoadExtension === 'function') raw.enableLoadExtension(false);
    },
    close: () => raw.close(),
  };
}

module.exports = { openDatabase };
