'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { API_TITLE } = require('./openapi');
const { buildStatusOpenApi } = require('./statusOpenapi');

/**
 * A separate, tiny "status API" that runs as its OWN process on its own port (default 4000), so it can still answer when the
 * main app is down:
 *   GET /health       -> 200 {"status":"ok"}                              everything is up
 *                     -> 503 {"error":"Service is not available", ...}    the main app (port 3000) is not running
 *                     -> 503 {"error":"LLM is not reachable", ...}        the main app is up but the LLM is not
 *   GET /docs         -> Swagger UI for this API        GET /openapi.json -> its OpenAPI description        GET / -> redirects to /docs
 * The main app has no health endpoint of its own, so it is recognised by what it does serve: GET /openapi.json must answer with the
 * FAQ RAG API's description. The app only starts listening after its index is built, so "answers" also means "ready". The LLM is
 * checked the same way the app talks to it (Ollama: /api/tags and the model is installed; Claude: list models with the API key).
 * Only the chat LLM is checked, not the embedding provider.
 */
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
const trim = (u) => u.replace(/\/$/, '');
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/** Reads the same LLM settings as the main app (same env var names and defaults), plus the status API's own. Throws on bad values. */
function loadStatusConfig(env = process.env) {
  const llmProvider = (env.LLM_PROVIDER || 'anthropic').toLowerCase();
  if (!['anthropic', 'ollama'].includes(llmProvider)) throw new Error(`LLM_PROVIDER must be one of: anthropic, ollama (got "${llmProvider}")`);
  if (llmProvider === 'anthropic' && !env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set (needed to check Claude when LLM_PROVIDER=anthropic). Copy .env.example to .env and set it.');
  }

  const port = int(env, 'STATUS_PORT', 4000);
  const appPort = int(env, 'PORT', 3000);
  const appUrl = trim(env.APP_URL || `http://127.0.0.1:${appPort}`);
  let parsed;
  try { parsed = new URL(appUrl); } catch { throw new Error(`APP_URL is not a valid URL: "${appUrl}"`); }
  const targetPort = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  if (LOCAL_HOSTS.has(parsed.hostname) && targetPort === port) {
    throw new Error(`STATUS_PORT (${port}) must differ from the main app's port, or the status API would check itself`);
  }

  return {
    port,
    appUrl,
    llmProvider,
    ollamaBaseUrl: trim(env.OLLAMA_BASE_URL || 'http://localhost:11434'),
    ollamaModel: env.OLLAMA_MODEL || 'llama3.1:8b',
    anthropicBaseUrl: trim(env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1'),
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    timeoutMs: int(env, 'STATUS_TIMEOUT_MS', 3000), // per check
    cacheMs: nonNegativeInt(env, 'STATUS_CACHE_MS', 5000), // how long a result is reused, so frequent polling doesn't hammer the LLM
  };
}

const describe = (err) => (err && err.name === 'TimeoutError' ? 'timed out' : err && err.name === 'SyntaxError' ? 'not JSON' : (err && (err.cause?.code || err.message)) || 'failed');

/** Is the main app running, and is it really the FAQ RAG app? It must answer GET /openapi.json with its own API description, in time. */
async function checkApp(cfg) {
  try {
    const res = await fetch(`${cfg.appUrl}/openapi.json`, { signal: AbortSignal.timeout(cfg.timeoutMs) });
    if (!res.ok) { res.body?.cancel(); return { ok: false, reason: `HTTP ${res.status}` }; }
    const body = await res.json();
    return body && body.info && body.info.title === API_TITLE ? { ok: true } : { ok: false, reason: 'not the FAQ RAG app' };
  } catch (err) {
    return { ok: false, reason: describe(err) };
  }
}

/** Can the LLM be reached and used? Never sends a prompt, so checking costs nothing. */
async function checkLlm(cfg) {
  const signal = () => AbortSignal.timeout(cfg.timeoutMs);
  try {
    if (cfg.llmProvider === 'ollama') {
      const res = await fetch(`${cfg.ollamaBaseUrl}/api/tags`, { signal: signal() });
      if (!res.ok) return { ok: false, message: 'LLM is not reachable', reason: `HTTP ${res.status}` };
      const names = ((await res.json()).models || []).map((m) => m.name);
      const want = cfg.ollamaModel;
      if (!names.includes(want) && !names.includes(`${want}:latest`)) {
        return { ok: false, message: `LLM model "${want}" is not installed`, reason: 'model missing' };
      }
      return { ok: true };
    }
    const res = await fetch(`${cfg.anthropicBaseUrl}/models`, {
      headers: { 'x-api-key': cfg.anthropicApiKey, 'anthropic-version': '2023-06-01' },
      signal: signal(),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, message: 'LLM rejected the API key', reason: `HTTP ${res.status}` };
    if (!res.ok) return { ok: false, message: 'LLM is not reachable', reason: `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, message: 'LLM is not reachable', reason: describe(err) };
  }
}

/** Runs both checks and turns them into an HTTP status and body. */
async function evaluate(cfg) {
  const [app, llm] = await Promise.all([checkApp(cfg), checkLlm(cfg)]);
  const checks = { app: app.ok ? 'ok' : 'down', llm: llm.ok ? 'ok' : 'down' };
  const detail = `app: ${app.ok ? 'ok' : `down (${app.reason})`}; llm: ${llm.ok ? 'ok' : `down (${llm.reason})`}`;
  if (!app.ok) return { status: 503, body: { error: 'Service is not available', checks }, detail };
  if (!llm.ok) return { status: 503, body: { error: llm.message, checks }, detail };
  return { status: 200, body: { status: 'ok' }, detail };
}

const DOCS_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'status-docs.html'));

function createStatusServer(cfg) {
  let cached = null;
  let inflight = null;
  let lastDetail = null;

  /** One shared check at a time, reused for cfg.cacheMs. A change (up -> down, down -> up) is logged once. */
  async function current() {
    if (cached && Date.now() - cached.at < cfg.cacheMs) return cached.result;
    if (!inflight) {
      inflight = evaluate(cfg).then((result) => {
        cached = { at: Date.now(), result };
        if (result.detail !== lastDetail) {
          lastDetail = result.detail;
          console.log(`[status] ${result.status === 200 ? 'all ok' : `${result.status} ${result.body.error}`} | ${result.detail}`);
        }
        return result;
      }).finally(() => { inflight = null; });
    }
    return inflight;
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const read = req.method === 'GET' || req.method === 'HEAD';
    const send = (status, payload, type = 'application/json', extra = {}) => {
      const body = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
      res.writeHead(status, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store', ...extra });
      res.end(req.method === 'HEAD' ? undefined : body);
    };

    if (read && url.pathname === '/health') {
      try {
        const result = await current();
        return send(result.status, result.body);
      } catch (err) {
        console.error('[status] check failed unexpectedly:', err.message);
        return send(500, { error: 'Internal server error' });
      }
    }
    if (read && url.pathname === '/openapi.json') return send(200, buildStatusOpenApi(cfg));
    if (read && (url.pathname === '/docs' || url.pathname === '/docs/')) return send(200, DOCS_HTML, 'text/html; charset=utf-8');
    if (read && url.pathname === '/') return send(302, '', 'text/plain', { Location: '/docs' }); // so opening the port in a browser lands on the docs
    return send(404, { error: 'Not found' });
  });
}

function main() {
  let cfg;
  try {
    cfg = loadStatusConfig();
  } catch (err) {
    console.error('Startup failed:', err.message);
    process.exit(1);
  }
  const llm = cfg.llmProvider === 'ollama' ? `Ollama (${cfg.ollamaModel}) at ${cfg.ollamaBaseUrl}` : `Claude at ${cfg.anthropicBaseUrl}`;
  createStatusServer(cfg).listen(cfg.port, () => {
    console.log(`Status API: http://localhost:${cfg.port}/health   (docs: http://localhost:${cfg.port}/docs)`);
    console.log(`  checks the app at ${cfg.appUrl} and the LLM: ${llm}`);
  });
}

if (require.main === module) main();

module.exports = { loadStatusConfig, createStatusServer, checkApp, checkLlm, evaluate };
