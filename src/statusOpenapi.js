'use strict';
const { version } = require('../package.json');

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

/**
 * OpenAPI 3 description of the status API, built from its running config so the numbers in it (timeout, cache time) are the
 * real ones. It deliberately says nothing about addresses, ports or keys: this document is served to anyone who can reach the port.
 */
function buildStatusOpenApi(cfg) {
  const llm = cfg.llmProvider === 'ollama' ? 'Ollama' : 'Claude';
  const unavailable = (summary, value) => ({ summary, value });

  return {
    openapi: '3.0.3',
    info: {
      title: 'FAQ RAG status API',
      version,
      description:
        'Tells you whether the FAQ RAG app is running and whether its LLM is reachable. It runs as a **separate process**, so it can still answer when the app is down.\n\n' +
        `**What it checks:** the main app (it must answer, and be the FAQ RAG app) and the LLM (${llm}). The LLM is checked with read-only calls and never receives a prompt, so checking costs nothing. ` +
        'The embedding provider and SQLite are not checked.\n\n' +
        `**Timing:** each check may take up to ${cfg.timeoutMs / 1000} s before it counts as down. ` +
        (cfg.cacheMs > 0 ? `A result is reused for ${cfg.cacheMs / 1000} s, so frequent polling does not hammer the LLM.` : 'Every request runs fresh checks (result reuse is switched off).') +
        '\n\n**No authentication.** Anyone who can reach this port can see whether the app and LLM are up.',
    },
    servers: [{ url: '/', description: 'This server' }],
    tags: [{ name: 'Status', description: 'Is the app running, and is the LLM reachable?' }],
    paths: {
      '/health': {
        get: {
          tags: ['Status'],
          summary: 'Is the app running and is the LLM reachable?',
          operationId: 'health',
          description:
            'Returns 200 only when both the app and the LLM are fine. Otherwise it returns **503** with an `error` message and a `checks` object saying which part is down. ' +
            'If both are down, the app problem is reported in `error`. `HEAD /health` works too and returns the same status code with no body.',
          responses: {
            200: {
              description: 'The app is running and the LLM is reachable',
              headers: { 'Cache-Control': { description: 'Always no-store', schema: { type: 'string' } } },
              content: { 'application/json': { schema: ref('StatusOk'), example: { status: 'ok' } } },
            },
            503: {
              description: 'The app is not running, or the LLM is not usable',
              headers: { 'Cache-Control': { description: 'Always no-store', schema: { type: 'string' } } },
              content: {
                'application/json': {
                  schema: ref('StatusUnavailable'),
                  examples: {
                    appDown: unavailable('The main app is not running (or answered badly, or too slowly)', { error: 'Service is not available', checks: { app: 'down', llm: 'ok' } }),
                    llmDown: unavailable('The app is up but the LLM cannot be reached', { error: 'LLM is not reachable', checks: { app: 'ok', llm: 'down' } }),
                    modelMissing: unavailable('Ollama is running but the configured model is not installed', { error: 'LLM model "llama3.1:8b" is not installed', checks: { app: 'ok', llm: 'down' } }),
                    keyRejected: unavailable('Claude rejected the API key', { error: 'LLM rejected the API key', checks: { app: 'ok', llm: 'down' } }),
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        StatusOk: { type: 'object', required: ['status'], additionalProperties: false, properties: { status: { type: 'string', enum: ['ok'] } } },
        StatusUnavailable: {
          type: 'object', required: ['error', 'checks'], additionalProperties: false,
          properties: {
            error: {
              type: 'string',
              description: 'What is wrong: "Service is not available" (the app), "LLM is not reachable", "LLM rejected the API key", or "LLM model \\"<name>\\" is not installed"',
            },
            checks: {
              type: 'object', required: ['app', 'llm'], additionalProperties: false,
              properties: {
                app: { type: 'string', enum: ['ok', 'down'], description: 'The main FAQ RAG app' },
                llm: { type: 'string', enum: ['ok', 'down'], description: 'The chat LLM' },
              },
            },
          },
        },
      },
    },
  };
}

module.exports = { buildStatusOpenApi };
