'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { buildOpenApi } = require('./openapi');
const { disabledPopular } = require('./popular');
const { validateUpload, listFaqFiles, writeFaqFiles, UploadError, MAX_UPLOAD_BODY_BYTES } = require('./faqStore');

class ValidationError extends Error {}

const MAX_BODY_BYTES = 10 * 1024;

/** Reads a JSON body. Bodies over `limit` are drained (so the 400 can still be delivered) and rejected. */
function readJson(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const parts = [];
    req.on('data', (c) => {
      if (tooLarge) return;
      size += c.length;
      if (size > limit) { tooLarge = true; parts.length = 0; return; }
      parts.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return reject(new ValidationError('Request body too large'));
      try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || 'null')); }
      catch { reject(new ValidationError('Body must be valid JSON')); }
    });
    req.on('error', reject);
  });
}

function validateAsk(body, cfg) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('Body must be a JSON object');
  const { question, top_k } = body;
  if (typeof question !== 'string' || question.trim() === '') throw new ValidationError('"question" must be a non-empty string');
  if (question.length > 1000) throw new ValidationError('"question" must be at most 1000 characters');
  let topK = cfg.defaultTopK;
  if (top_k !== undefined) {
    if (!Number.isInteger(top_k) || top_k < 1 || top_k > cfg.maxTopK) {
      throw new ValidationError(`"top_k" must be an integer between 1 and ${cfg.maxTopK}`);
    }
    topK = top_k;
  }
  return { question: question.trim(), topK };
}

function send(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'));

const DOCS_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'docs.html'));

function sendHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length });
  res.end(html);
}

function createServer(rag, cfg, popular = disabledPopular()) {
  let busy = false; // one re-index (reload or upload) at a time

  return http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/') return sendHtml(res, INDEX_HTML);

      if (req.method === 'GET' && (url.pathname === '/docs' || url.pathname === '/docs/')) return sendHtml(res, DOCS_HTML);

      if (req.method === 'GET' && url.pathname === '/openapi.json') return send(res, 200, buildOpenApi(cfg));

      if (req.method === 'GET' && url.pathname === '/popular') return send(res, 200, { enabled: popular.enabled, questions: await popular.top() });

      if (req.method === 'POST' && url.pathname === '/ask') {
        const { question, topK } = validateAsk(await readJson(req), cfg);
        const bypassCache = /\bno-cache\b/i.test(req.headers['cache-control'] || ''); // standard way to ask for a fresh answer
        const { answer, sources, cached } = await rag.ask(question, topK, { bypassCache });
        await popular.record(question); // only answered questions are counted (cached ones too); never throws
        // the body stays exactly { answer, sources }; whether it came from the cache is reported in a header
        send(res, 200, { answer, sources }, cached === undefined ? {} : { 'X-Cache': cached ? 'HIT' : 'MISS' });
        // say where the answer came from: the SQLite cache (no retrieval, no model call) or a full run of vector search + the chat model
        const from = cached === true ? 'SQLite answer cache (hit)'
          : cached === false ? `vector search + LLM (${bypassCache ? 'cache bypassed' : 'cache miss'})`
            : 'vector search + LLM (cache off)';
        console.log(`POST /ask 200 ${Date.now() - started}ms | from: ${from} | top_k=${topK} | sources=${sources.join(',')}`);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/reload') {
        if (busy) return send(res, 409, { error: 'Another reload or upload is already in progress' });
        busy = true;
        try {
          // ingest() builds the new index off to the side and swaps it in only on success,
          // so questions keep being answered from the old index while this runs or if it fails.
          const { files, chunks } = await rag.ingest();
          send(res, 200, { status: 'ok', files, chunks });
          console.log(`POST /reload 200 ${Date.now() - started}ms files=${files} chunks=${chunks}`);
        } catch (err) {
          console.error('POST /reload 500:', err.message);
          send(res, 500, { error: 'Reload failed; the previous index is still in use. Check the server log.' });
        } finally {
          busy = false;
        }
        return;
      }

      if (req.method === 'GET' && url.pathname === '/vectors') return send(res, 200, await rag.map());

      if (req.method === 'POST' && url.pathname === '/inspect') {
        const { question, topK } = validateAsk(await readJson(req), cfg);
        return send(res, 200, await rag.inspect(question, topK));
      }

      if (req.method === 'GET' && url.pathname === '/faqs') {
        return send(res, 200, { files: await listFaqFiles(cfg.faqDir) });
      }

      if (req.method === 'POST' && url.pathname === '/faqs') {
        const files = validateUpload(await readJson(req, MAX_UPLOAD_BODY_BYTES));
        // check-and-set with no await in between, so two uploads can't both get in
        if (busy) return send(res, 409, { error: 'Another reload or upload is already in progress' });
        busy = true;
        try {
          const { saved, rollback } = await writeFaqFiles(cfg.faqDir, files);
          try {
            const { files: fileCount, chunks } = await rag.ingest();
            send(res, 200, { status: 'ok', saved, files: fileCount, chunks });
            console.log(`POST /faqs 200 ${Date.now() - started}ms saved=${saved.map((s) => s.name).join(',')} chunks=${chunks}`);
          } catch (err) {
            await rollback(); // keep disk and index consistent: the upload is all-or-nothing
            console.error('POST /faqs 500 (rolled back):', err.message);
            send(res, 500, { error: 'Indexing failed, so no files were saved and the previous index is still in use. Check the server log.' });
          }
        } finally {
          busy = false;
        }
        return;
      }

      send(res, 404, { error: 'Not found' });
    } catch (err) {
      if (err instanceof ValidationError || err instanceof UploadError) return send(res, 400, { error: err.message });
      console.error(`${req.method} ${url.pathname} 500:`, err.message);
      send(res, 500, { error: 'Internal server error' });
    }
  });
}

module.exports = { createServer, validateAsk, ValidationError };
