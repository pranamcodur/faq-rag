'use strict';
const { MAX_UPLOAD_FILES, MAX_FILE_BYTES, MAX_UPLOAD_BODY_BYTES } = require('./faqStore');
const { version } = require('../package.json');

/** The title of this API's description. The status API uses it to recognise that port 3000 really is this app. */
const API_TITLE = 'FAQ RAG API';

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema, example) => ({ 'application/json': { schema, ...(example !== undefined ? { example } : {}) } });
const errorResponse = (description) => ({ description, content: json(ref('Error'), { error: description }) });

/** OpenAPI 3 description of this server, built from the running config so limits and defaults never go stale. */
function buildOpenApi(cfg) {
  const chunkExample = (rank, used) => ({ rank, id: rank - 1, file: 'sso.md', text: '## How do I configure SSO? An admin opens Settings > Security > SSO, selects SAML 2.0, and uploads the identity provider', score: 0.8123, used, added_for_diversity: false });

  return {
    openapi: '3.0.3',
    info: {
      title: API_TITLE,
      version,
      description:
        'Answers questions from a folder of FAQ markdown files using retrieval-augmented generation.\n\n' +
        '**Cost and speed:** `POST /ask` calls the chat model (slow with a local model) unless the answer is cached. `POST /faqs` and `POST /reload` re-embed all FAQ files. ' +
        '`POST /inspect` embeds the question but generates no answer (a multi-part question uses the chat model once, to split it).\n\n' +
        '**No authentication.** Intended for localhost.\n\n' +
        '**Is it up?** This app has no health endpoint of its own. A separate status API (`npm run status`, default port 4000, with its own docs at `/docs`) reports whether this app and the LLM are running.',
    },
    servers: [{ url: '/', description: 'This server' }],
    tags: [
      { name: 'Ask', description: 'Ask a question and get an answer with sources' },
      { name: 'FAQ files', description: 'List, upload and re-index the FAQ documents' },
      { name: 'Retrieval inspector', description: 'See what retrieval does (powers the Vector map in the web UI)' },
    ],
    paths: {
      '/ask': {
        post: {
          tags: ['Ask'], summary: 'Ask a question', operationId: 'ask',
          description: 'Retrieves the most relevant FAQ chunks by cosine similarity and has the chat model answer from them. ' +
            'A question that looks multi-part is first split into sub-questions (see `QUERY_DECOMPOSITION`). `sources` are the files of the chunks given to the model, never text the model wrote.\n\n' +
            '**Answer cache** (needs SQLite, on by default): a repeated question (case, spacing and trailing punctuation ignored) is answered from a saved copy without retrieval or a model call. ' +
            'The `X-Cache` response header says `HIT` or `MISS`. Saved answers are discarded when the FAQ content, models or settings change, and expire after `ANSWER_CACHE_TTL_HOURS`. ' +
            'Send `Cache-Control: no-cache` to force a fresh answer (which also refreshes the saved one).',
          parameters: [{ name: 'Cache-Control', in: 'header', required: false, description: 'Send `no-cache` to skip the answer cache for this request', schema: { type: 'string', enum: ['no-cache'] } }],
          requestBody: { required: true, content: json(ref('AskRequest'), { question: 'How do I enable two-factor authentication?', top_k: cfg.defaultTopK }) },
          responses: {
            200: { description: 'Answer and the FAQ files it was based on', headers: { 'X-Cache': { description: 'HIT if the answer came from the answer cache, MISS if it was generated. Absent when the cache is off.', schema: { type: 'string', enum: ['HIT', 'MISS'] } } }, content: json(ref('AskResponse'), { answer: 'Open Settings > Security and choose “Enable 2FA”… (see authentication.md)', sources: ['authentication.md', 'sso.md'] }) },
            400: errorResponse('"question" must be a non-empty string'),
            500: errorResponse('Internal server error'),
          },
        },
      },
      '/popular': {
        get: {
          tags: ['Ask'], summary: 'Most asked questions', operationId: 'popular',
          description: 'The questions asked most often, most asked first (ties: the most recently asked first). A question is counted when `/ask` answers it; case, spacing and trailing punctuation are ignored. ' +
            'Stored in a SQLite file, so it survives restarts. `enabled` is false when SQLite is switched off or unavailable. The web UI shows this under “Most asked”.',
          responses: { 200: { description: 'The current top questions', content: json(ref('PopularResponse'), { enabled: true, questions: [{ question: 'How do I reset my password?', count: 3 }, { question: 'How much PTO do I get?', count: 2 }] }) } },
        },
      },
      '/faqs': {
        get: {
          tags: ['FAQ files'], summary: 'List FAQ files', operationId: 'listFaqs',
          description: 'The `.md` files currently in the FAQ folder (the folder, not necessarily what is indexed until a reload).',
          responses: { 200: { description: 'File names', content: json(ref('FaqList'), { files: ['authentication.md', 'employee-policy.md', 'sso.md'] }) } },
        },
        post: {
          tags: ['FAQ files'], summary: 'Upload FAQ files and re-index', operationId: 'uploadFaqs',
          description: `Saves up to ${MAX_UPLOAD_FILES} markdown files (${MAX_FILE_BYTES / 1024} KB each) into the FAQ folder and re-indexes. A file with an existing name replaces it. ` +
            'All-or-nothing: if indexing fails, new files are removed and replaced files restored. Names must be plain (letters, digits, spaces, `_ . ( ) -`) and end in `.md`.',
          requestBody: { required: true, content: json(ref('FaqUploadRequest'), { files: [{ name: 'swagger-example.md', content: '# Example FAQ\n\n## Where is the example?\nThis file was uploaded from the API docs page.\n' }] }) },
          responses: {
            200: { description: 'Saved and indexed', content: json(ref('FaqUploadResponse'), { status: 'ok', saved: [{ name: 'swagger-example.md', replaced: false }], files: 4, chunks: 12 }) },
            400: errorResponse('Invalid file name, content or count'),
            409: errorResponse('Another reload or upload is already in progress'),
            500: errorResponse('Indexing failed, so no files were saved and the previous index is still in use.'),
          },
        },
      },
      '/reload': {
        post: {
          tags: ['FAQ files'], summary: 'Re-read the FAQ folder', operationId: 'reload',
          description: 'Rebuilds the index from the files on disk (use after changing the folder by hand). The new index replaces the old one only on success.',
          responses: {
            200: { description: 'Re-indexed', content: json(ref('ReloadResponse'), { status: 'ok', files: 3, chunks: 11 }) },
            409: errorResponse('Another reload or upload is already in progress'),
            500: errorResponse('Reload failed; the previous index is still in use.'),
          },
        },
      },
      '/vectors': {
        get: {
          tags: ['Retrieval inspector'], summary: 'All chunks projected to 2D', operationId: 'vectors',
          description: 'Every indexed chunk with 2D coordinates (PCA of the embedding vectors). The size grows with the corpus.',
          responses: { 200: { description: 'The map', content: json(ref('VectorsResponse')) } },
        },
      },
      '/inspect': {
        post: {
          tags: ['Retrieval inspector'], summary: 'Show what retrieval does for a question', operationId: 'inspect',
          description: 'Runs retrieval exactly as `/ask` would, but returns the ranked chunks with cosine scores and which were chosen as context instead of an answer. ' +
            '`parts` has one entry normally, or one per sub-question for a multi-part question.',
          requestBody: { required: true, content: json(ref('AskRequest'), { question: 'How do I configure SSO?', top_k: cfg.defaultTopK }) },
          responses: {
            200: { description: 'Ranked chunks per part', content: json(ref('InspectResponse')) },
            400: errorResponse('"question" must be a non-empty string'),
            500: errorResponse('Internal server error'),
          },
        },
      },
    },
    components: {
      schemas: {
        Error: { type: 'object', required: ['error'], properties: { error: { type: 'string' } } },
        AskRequest: {
          type: 'object', required: ['question'],
          properties: {
            question: { type: 'string', minLength: 1, maxLength: 1000, description: 'The question in plain language' },
            top_k: { type: 'integer', minimum: 1, maximum: cfg.maxTopK, default: cfg.defaultTopK, description: 'How many chunks (“excerpts”) to give the model. A multi-part question gives each part about half of this, at least 2.' },
          },
        },
        AskResponse: {
          type: 'object', required: ['answer', 'sources'], additionalProperties: false,
          properties: { answer: { type: 'string' }, sources: { type: 'array', items: { type: 'string' }, description: 'Distinct FAQ file names the answer was based on' } },
        },
        PopularResponse: {
          type: 'object', required: ['enabled', 'questions'],
          properties: {
            enabled: { type: 'boolean', description: 'False when SQLite is off or unavailable' },
            questions: { type: 'array', items: { type: 'object', required: ['question', 'count'], properties: { question: { type: 'string' }, count: { type: 'integer', description: 'Times asked' } } } },
          },
        },
        FaqList: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } } },
        FaqFile: {
          type: 'object', required: ['name', 'content'],
          properties: {
            name: { type: 'string', maxLength: 100, description: 'Plain file name ending in .md' },
            content: { type: 'string', description: `Markdown text, at most ${MAX_FILE_BYTES / 1024} KB` },
          },
        },
        FaqUploadRequest: {
          type: 'object', required: ['files'],
          description: `JSON body of at most ${MAX_UPLOAD_BODY_BYTES / 1024 / 1024} MB`,
          properties: { files: { type: 'array', minItems: 1, maxItems: MAX_UPLOAD_FILES, items: ref('FaqFile') } },
        },
        FaqUploadResponse: {
          type: 'object', required: ['status', 'saved', 'files', 'chunks'],
          properties: {
            status: { type: 'string', enum: ['ok'] },
            saved: { type: 'array', items: { type: 'object', required: ['name', 'replaced'], properties: { name: { type: 'string' }, replaced: { type: 'boolean' } } } },
            files: { type: 'integer', description: 'FAQ files now indexed' },
            chunks: { type: 'integer', description: 'Chunks now indexed' },
          },
        },
        ReloadResponse: {
          type: 'object', required: ['status', 'files', 'chunks'],
          properties: { status: { type: 'string', enum: ['ok'] }, files: { type: 'integer' }, chunks: { type: 'integer' } },
        },
        Point: {
          type: 'object', required: ['id', 'file', 'text', 'x', 'y'],
          properties: { id: { type: 'integer' }, file: { type: 'string' }, text: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } },
        },
        VectorsResponse: {
          type: 'object', required: ['count', 'dimensions', 'explained_variance', 'files', 'points'],
          properties: {
            count: { type: 'integer' },
            dimensions: { type: 'integer', description: 'Size of the embedding vectors' },
            explained_variance: { type: 'array', items: { type: 'number' }, description: 'Share of the variation kept by each of the two axes' },
            files: { type: 'array', items: { type: 'string' } },
            points: { type: 'array', items: ref('Point') },
          },
        },
        ChunkResult: {
          type: 'object', required: ['rank', 'id', 'file', 'text', 'score', 'used', 'added_for_diversity'],
          properties: {
            rank: { type: 'integer', description: 'Position by cosine similarity within this part (1 = best)' },
            id: { type: 'integer' }, file: { type: 'string' }, text: { type: 'string' },
            score: { type: 'number', description: 'Cosine similarity with the question' },
            used: { type: 'boolean', description: 'Given to the model as context' },
            added_for_diversity: { type: 'boolean', description: 'Swapped in so the answer can cite a second file' },
          },
          example: chunkExample(1, true),
        },
        InspectPart: {
          type: 'object', required: ['question', 'x', 'y', 'results'],
          properties: { question: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, results: { type: 'array', items: ref('ChunkResult') } },
        },
        InspectResponse: {
          type: 'object', required: ['question', 'top_k', 'per_part', 'mode', 'sources', 'parts'],
          properties: {
            question: { type: 'object', required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } }, description: 'Where the whole question lands on the map' },
            top_k: { type: 'integer' },
            per_part: { type: 'integer', description: 'Excerpts each part retrieves itself (equals top_k for a normal question)' },
            mode: { type: 'string', enum: ['single', 'compound'] },
            sources: { type: 'array', items: { type: 'string' } },
            parts: { type: 'array', items: ref('InspectPart') },
          },
        },
      },
    },
  };
}

module.exports = { buildOpenApi, API_TITLE };
