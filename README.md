# FAQ RAG (Node.js)

Minimal Retrieval-Augmented Generation prototype over markdown FAQ files, exposed as a local HTTP API.
Node 18+. Built on the built-in `http` and `fetch`. npm packages: `@huggingface/transformers` (only for local embeddings; hosted setups never load it) and, optionally, `better-sqlite3` (SQLite) and `sqlite-vec` (vector search inside SQLite); see below.

## Run

Pick one provider for answers and one for embeddings (set in `.env`):

| `LLM_PROVIDER` (answers) | needs |
|---|---|
| `anthropic` (default) | `ANTHROPIC_API_KEY` |
| `ollama` | Ollama running locally with the model pulled |

| `EMBEDDING_PROVIDER` (vectors) | needs |
|---|---|
| `voyage` (default) | `VOYAGE_API_KEY` |
| `local` | `npm install` (Hugging Face model runs on your machine) |

**Hosted (Claude + Voyage):**
```bash
cp .env.example .env        # set ANTHROPIC_API_KEY and VOYAGE_API_KEY
node --env-file=.env src/index.js      # Node 20.6+
```

**Fully local (Ollama + Hugging Face embeddings, no API keys, no data leaves your machine):**
```bash
ollama pull llama3.1:8b                # skip if already installed
npm install                            # installs @huggingface/transformers
cp .env.example .env                   # defaults are already ollama + local embeddings + llama3.1:8b
node --env-file=.env src/index.js      # Node 20.6+ (or: npm start with the variables exported)
```
The first run downloads the embedding model (~25 MB, `Xenova/all-MiniLM-L6-v2`) from the Hugging Face Hub and caches it; after that it works offline.
Mixing is fine too, e.g. `EMBEDDING_PROVIDER=local` with `LLM_PROVIDER=anthropic` needs only the Anthropic key.

On startup the app logs which providers it is using, checks they are available (Ollama reachable and the model installed, local embedding model loaded), chunks and embeds everything in `faqs/` (in memory), then listens on `:3000`. It exits immediately with a clear message if a key or dependency the chosen providers need is missing.

After adding, editing or deleting files in `faqs/`, apply the changes without restarting: click **Reload FAQs** in the web UI, or run `curl -X POST localhost:3000/reload`.

`sample-faqs/` holds seven extra example FAQ files (expenses, IT, benefits, onboarding, billing, privacy, API) that are *not* indexed by default: upload them through the UI, or copy them into `faqs/` and click **Reload FAQs**.

**Vector map:** open the *Vector map* panel to see every chunk as a dot, coloured by source file (hover for the text, click a legend
item to focus one file). Type a question under *Inspect* — or click *Show on vector map* under any answer — to see where the
question lands, dashed lines to the chunks retrieval picked, and a ranked list with exact cosine scores.

**Most asked (SQLite):** the app counts every question it answers and stores the counts in a SQLite file (`./data/faq-rag.db`, created on first use, so
the list survives restarts). The two most asked appear under **Most asked** below the starter examples, with how many times each was asked; the list re-ranks after
every question, and clicking one asks it. It is on by default and needs no service to run.

How SQLite is provided (`npm install` is enough): the optional dependency **`better-sqlite3`** is used when it installed properly; otherwise the app falls back to
Node's built-in **`node:sqlite`** (Node 22.5+, which prints an "experimental" notice). If neither is available the app still runs and "Most asked" is simply off,
with a message saying why. `SQLITE_DRIVER` can force one (`better-sqlite3` or `node`); the default is `auto`.
```bash
npm install                                   # better-sqlite3 downloads a prebuilt binary; if that fails the install still succeeds
npm start                                     # "Most asked questions are stored in SQLite: ... (driver: ...)" shows which driver is in use
sqlite3 data/faq-rag.db "select times_asked, display from question_stats order by times_asked desc"   # peek (optional CLI)
rm data/faq-rag.db*                           # reset the list (stop the app first)
```
Settings: `SQLITE_PATH` (`./data/faq-rag.db`; `off` disables the feature, `:memory:` keeps it in RAM only), `SQLITE_DRIVER` (`auto`),
`POPULAR_LIMIT` (2, max 10), `POPULAR_MIN_COUNT` (1: show a question only once it has been asked this many times).

**Vector store (SQLite + sqlite-vec):** the chunks and their vectors are saved in the same SQLite file (`faq_chunks`, plus a `vec0` virtual table from
the **sqlite-vec** extension), instead of living only in memory. What that buys you:
- **Restarts embed nothing.** The saved vectors are loaded back; each FAQ file is stored with a hash of its text.
- **Edits are cheap.** Uploading a file, or clicking **Reload FAQs**, re-embeds only files that are new or changed (a real saving with Voyage or a large corpus); removed files are deleted.
- **Search runs inside SQLite** (nearest-neighbour, exact) when sqlite-vec is available. If it isn't, the same saved vectors are searched in Node, exactly as before.

`npm install` gets the optional `sqlite-vec` package (it ships a prebuilt binary per platform; if there isn't one for yours the install still succeeds). Loading it needs the
`better-sqlite3` driver, or Node 22.13+ for the built-in one. The startup log says which mode you got:
```
Vector store: SQLite + sqlite-vec v0.1.x (vectors are saved in the database and searched inside SQLite)
Vector store: SQLite (vectors are saved in the database and searched in Node; sqlite-vec not used: <reason>)
Vector store: in memory only (rebuilt at every start)
Indexed 14 chunks from 3 files (0 embedded, 14 reused from SQLite)
```
`VECTOR_STORE` picks the mode: `auto` (default; same as `sqlite-vec`: try the extension, fall back if needed), `sqlite` (save in SQLite, never use the extension) or
`memory` (the old behaviour: nothing saved). With `SQLITE_PATH=off` it is `memory`. A vector is only reused if the embedding model, chunk size and the file's text are all unchanged; change any of them and
that data is re-embedded and replaced. Delete `data/faq-rag.db*` to start from scratch.

**Answer cache (SQLite):** a repeated question is answered from a saved copy, with no retrieval and no chat-model call, so it comes back almost
instantly (which matters most with a local model). It is on by default whenever SQLite is available. Questions match regardless of case, spacing and trailing
punctuation, and the same `top_k`; the page shows a small **from cache** tag, and the API reports it in an `X-Cache: HIT|MISS` response header (the body stays exactly
`{answer, sources}`). Send `Cache-Control: no-cache` to force a fresh answer, which also refreshes the saved one.

The server console says where every answer came from, with the time it took:
```
POST /ask 200 2310ms | from: vector search + LLM (cache miss) | top_k=4 | sources=authentication.md,sso.md
POST /ask 200 1ms    | from: SQLite answer cache (hit)        | top_k=4 | sources=authentication.md,sso.md
```
`vector search + LLM` has three qualifiers: `cache miss`, `cache bypassed` (you sent `Cache-Control: no-cache`) and `cache off`.

Saved answers are never served when they could be wrong. Each one is stored with a *fingerprint* of everything it depends on: the text of every FAQ chunk, the embedding
and chat models, chunking, splitting mode, answer length and the prompts. Edit, add or remove an FAQ file (including via the upload UI or **Reload FAQs**), change a model or
a setting, or update the code's prompts, and old answers stop matching and are deleted on the next index build. Reloading unchanged files keeps the cache, and so does a restart.
Entries also expire after `ANSWER_CACHE_TTL_HOURS` (168 = 7 days; 0 = never) and the table keeps at most `ANSWER_CACHE_MAX_ENTRIES` (1000), dropping the least recently used.
```bash
curl -si -X POST localhost:3000/ask -d '{"question":"How do I enable 2FA?"}' | grep -i x-cache     # X-Cache: MISS, then HIT on the second call
sqlite3 data/faq-rag.db "select hits, question from answer_cache order by hits desc"             # peek (optional CLI)
sqlite3 data/faq-rag.db "delete from answer_cache"                                               # clear it (or delete the file)
```
Settings: `ANSWER_CACHE` (`on`/`off`), `ANSWER_CACHE_TTL_HOURS`, `ANSWER_CACHE_MAX_ENTRIES`. It needs SQLite: with `SQLITE_PATH=off` or no SQLite driver the cache is off and everything else works as before.

**Status API (port 4000):** a separate, tiny service that tells you whether the app is up. It is its own process, so it can still answer when the app is down. The app itself has
**no `/health` endpoint**; this is where `GET /health` lives now.
```bash
node --env-file=.env src/status.js        # or: npm run status      (in a second terminal)
curl -i localhost:4000/health
```
| Situation | Response |
|---|---|
| App on port 3000 is running and the LLM is reachable | `200 {"status":"ok"}` |
| App is not running (or answers badly, or too slowly) | `503 {"error":"Service is not available","checks":{"app":"down","llm":"ok"}}` |
| App is up but the LLM is not reachable | `503 {"error":"LLM is not reachable","checks":{"app":"ok","llm":"down"}}` |
| Ollama is up but your model is not installed | `503 {"error":"LLM model \"llama3.1:8b\" is not installed", ...}` |
| Claude rejects the API key | `503 {"error":"LLM rejected the API key", ...}` |

**Swagger docs for the status API:** open **http://localhost:4000/docs** (opening `http://localhost:4000/` redirects there) and use **Try it out** on `GET /health`; the 503 responses are documented with an example for each
situation above. The OpenAPI description is at `http://localhost:4000/openapi.json`. Like the main app's docs page, it loads Swagger UI from a pinned CDN link, so that page needs internet access in your browser.
The description is generated from the running settings (timeout and result-reuse time) and deliberately contains no addresses, ports or keys.

How it checks: the app has no health endpoint, so it is recognised by what it does serve: `GET /openapi.json` must answer with the FAQ RAG API's own description (anything else on that port counts as "not available"). The app only
starts listening once its index is built, so "answers" also means "ready". The LLM is checked the way the app uses it (Ollama: `/api/tags` and the model is installed; Claude: list models with your key); it only reads, never sends a
prompt, so checking costs nothing. It reads the same `LLM_PROVIDER`, `OLLAMA_*`, `ANTHROPIC_*` and `PORT` settings as the app, plus `STATUS_PORT` (4000), `APP_URL` (default `http://127.0.0.1:$PORT`),
`STATUS_TIMEOUT_MS` (3000 per check) and `STATUS_CACHE_MS` (5000: a result is reused this long, so frequent polling does not hammer the LLM; set 0 to check every time). A change of state is logged once
(`[status] 503 LLM is not reachable | app: ok; llm: down (ECONNREFUSED)`). Only the chat LLM is checked, not the embedding provider or SQLite. `GET` and `HEAD` work on `/health`.

**Testing the API in the browser:** open **http://localhost:3000/docs**, expand an endpoint, click **Try it out** (each one is pre-filled with a working
example) and **Execute**. `/openapi.json` can also be imported into Postman or any OpenAPI tool. Swagger UI is loaded from a CDN, so that page needs
internet access in your browser; if it can't load, the page says so and `/openapi.json` still works.

To add FAQs from the browser, open **Add or update FAQ files** in the UI, choose or drop several `.md` files and click **Upload and index**.

Then open **http://localhost:3000** for the web UI (ask questions in the browser; answers show the source files as tags).
The same server also exposes the API:

```bash
# {"status":"ok"}

curl -X POST localhost:3000/ask -H 'Content-Type: application/json' \
  -d '{"question":"How do I enable 2FA?","top_k":4}'
# {"answer":"...","sources":["authentication.md","sso.md"]}
```

Tests (no API key or network needed – uses a local mock Anthropic/Voyage server): `npm test`

## Layout

| File | Role |
|---|---|
| `src/chunker.js` | ~200-char word-boundary chunker with small overlap |
| `src/similarity.js` | cosine similarity |
| `src/llm.js` | provider selection: Anthropic / Ollama (answers), Voyage / local (embeddings); timeout + retries; startup checks |
| `src/decompose.js` | multi-part question detection, the splitting prompt, and tolerant parsing of the model's reply |
| `src/projection.js` | dependency-free 2-component PCA (power iteration) used by the vector map |
| `src/localEmbedder.js` | Hugging Face transformers.js embedder (lazy-loaded) |
| `src/rag.js` | ingest, retrieve (top-k cosine), answer generation |
| `src/app.js` | HTTP server, validation, status codes, serves the UI at `/` |
| `src/vectorStore.js` | saves chunks + vectors in SQLite; nearest-neighbour search with sqlite-vec (with a self-test and a safe fallback) |
| `src/status.js` | the separate status API (port 4000): checks the app and the LLM, answers 503 if either is down; serves its own Swagger docs |
| `src/statusOpenapi.js` | OpenAPI description of the status API (built from its running settings) |
| `public/status-docs.html` | Swagger UI page for the status API, served at its `/docs` |
| `src/db.js` | SQLite adapter: better-sqlite3 (npm) or node:sqlite (built in), one small interface |
| `src/answerCache.js` | answer cache in SQLite: saved answers keyed by question, `top_k` and a content/model/settings fingerprint |
| `src/normalize.js` | shared question normalisation (case, spacing, trailing punctuation) |
| `src/popular.js` | "Most asked": counts questions in a `question_stats` table |
| `src/openapi.js` | OpenAPI 3 spec, built from the live config (limits, defaults) |
| `public/docs.html` | Swagger UI page served at `/docs` |
| `src/faqStore.js` | FAQ file upload: validation, listing, write-with-rollback |
| `public/index.html` | single-file web UI (vanilla JS, no build step; light/dark) |
| `src/index.js` | wiring + fail-fast startup |

## API

- `GET /` → the web UI
- `GET /docs` → interactive **Swagger UI** to try every endpoint from the browser; `GET /openapi.json` → the OpenAPI 3 description
- `GET /popular` → `200 {"enabled":bool,"questions":[{"question","count"}]}`: the most asked questions (top 2 by default), most asked first;
  `enabled` is false and the list empty when SQLite is off or unavailable
- `GET /vectors` → `200 {"count","dimensions","explained_variance":[r1,r2],"files":[...],"points":[{"id","file","text","x","y"}]}`:
  every indexed chunk projected to 2D (read-only; powers the vector map)
- `POST /inspect` body `{"question": string, "top_k"?: integer}` (same validation as `/ask`) → `200
  {"question":{"x","y"},"top_k","per_part","mode":"single"|"compound","sources":[...],"parts":[{"question","x","y","results":[...]}]}`
  where each result is `{"rank","id","file","text","score","used","added_for_diversity"}`.
  Shows what retrieval would do: for each part (one for a normal question, one per sub-question for a multi-part one) the
  top-ranked chunks with exact cosine scores, and which ones would be sent to the model (`used`). `question` is where the whole
  question's own vector lands. No answer is generated (a multi-part question still uses the chat model once, to split it).
- `GET /faqs` → `200 {"files":["authentication.md", ...]}` (the `.md` files in the FAQ folder)
- `POST /faqs` body `{"files":[{"name":"x.md","content":"..."}, ...]}` → saves the files into the FAQ folder and re-indexes
  - `200 {"status":"ok","saved":[{"name":"x.md","replaced":false}],"files":N,"chunks":M}`
  - `400 {"error":...}` – 1 to 20 files; each name must be a plain name ending in `.md` (no paths or `..`), unique within the
    request (case-insensitive), content a non-empty text string of at most 200 KB; body at most 8 MB
  - `409 {"error":...}` if a reload or upload is already running
  - `500 {"error":...}` if indexing fails; the upload is all-or-nothing, so new files are removed, replaced files are restored,
    and the previous index stays in use
- `POST /reload` (no body) → re-reads `faqs/` and rebuilds the index without restarting
  - `200 {"status":"ok","files":N,"chunks":M}`
  - `409 {"error":...}` if a reload or upload is already running
  - `500 {"error":...}` if it fails (e.g. no `.md` files, embedding error); the previous index stays in use
- `POST /ask` body `{"question": string, "top_k"?: integer}`
  - `200 {"answer": string, "sources": string[]}` (exactly these keys)
  - `400 {"error": ...}` – invalid JSON, empty/non-string question (max 1000 chars), `top_k` not an integer in 1..10, body > 10KB
  - `500 {"error": ...}` – upstream/model failure or other internal error

## Multi-part questions

A question like "How do I enable 2FA and how many PTO days do I get?" becomes one blended vector that sits between two topics
and can match neither well. So, when a question *looks* multi-part (two question marks, a semicolon, or a word like "and" or
"also"), the app first asks the chat model to split it into sub-questions, then:

1. embeds each sub-question and retrieves for each part separately (each part gets at least 2 excerpts, or half of `top_k`),
2. merges the results round-robin so no part crowds out another, removes duplicates and caps the context at 12 chunks,
3. sends the model the excerpts grouped as "Part 1 / Part 2 ..." and a prompt that says to answer every part the context covers and to
   say which part is not covered, instead of refusing the whole question.

Ordinary questions skip all of this, so they cost nothing extra. If the split fails or returns a single part, the normal path is
used. `QUERY_DECOMPOSITION` controls it: `auto` (default), `off` (never split) or `always` (try on every question).
The Vector map shows the split: a hollow marker for the whole question and one numbered marker per part, each with its own results.

## Config (env)

`LLM_PROVIDER` (anthropic | ollama), `EMBEDDING_PROVIDER` (voyage | local),
`ANTHROPIC_API_KEY` / `CHAT_MODEL` (claude-haiku-5-5) when using Anthropic, `VOYAGE_API_KEY` when using Voyage,
`OLLAMA_BASE_URL` (http://localhost:11434), `OLLAMA_MODEL` (llama3.1:8b),
`EMBEDDING_MODEL` (voyage-3.5-lite, or Xenova/all-MiniLM-L6-v2 for local), `ANTHROPIC_BASE_URL`, `VOYAGE_BASE_URL`, `MAX_ANSWER_TOKENS` (500), `FAQ_DIR`, `PORT`, `CHUNK_SIZE` (200), `CHUNK_OVERLAP` (30), `DEFAULT_TOP_K` (4),
`QUERY_DECOMPOSITION` (auto | off | always), `MAX_TOP_K` (10), `REQUEST_TIMEOUT_MS` (30000; 120000 with Ollama), `MAX_RETRIES` (2).

## Design decisions & trade-offs

- **Chunking:** ~200 chars on word boundaries with a 30-char overlap. Small chunks give precise retrieval but can
  split an answer across chunks (overlap mitigates this) and lose heading context. The filename is prepended to the
  text that gets *embedded* (not shown to the user) to give short chunks some topical signal. A heading-aware
  chunker would be the first upgrade.
- **Vector store:** a plain in-memory array + brute-force cosine. Exact, simple, and instant for a few hundred chunks.
  The index is rebuilt in full at startup and on `POST /reload` (one embedding call per 100 chunks). A reload builds the
  new index aside and swaps it in only on success, so a failed reload never breaks a running app, and concurrent reloads
  are rejected with 409. `/reload` has no auth, which is fine on localhost but would need protecting if exposed, since it
  triggers embedding calls. For larger corpora: persist vectors, re-embed only changed files, and use an ANN index / vector DB.
- **Retrieval:** top-k (default 4) by cosine similarity. No score threshold, so there is always *some* context;
  the prompt instructs the model to say it doesn't know when the context doesn't contain the answer.
- **Citing ≥ 2 sources:** `sources` is built from the files of the retrieved chunks (deduplicated, rank order), not
  parsed from model output, so it is deterministic and can't be hallucinated. If all top-k chunks come from a
  single file and other files exist, the lowest-ranked chunk is swapped for the best chunk from another file. This
  guarantees ≥ 2 sources when available, at the cost of occasionally including a marginally relevant file.
  (`top_k=1` returns one source by definition.)
- **Why separate answer and embedding providers:** Anthropic has no embeddings endpoint, so vectors come from Voyage AI
  (Anthropic's recommended partner) or from a local Hugging Face model. Voyage's `input_type` is set to `document` when
  indexing and `query` when searching. Local MiniLM-style models use one encoding for both.
- **Local embeddings:** `all-MiniLM-L6-v2` (384 dims) is small and fast on CPU and good enough for short FAQ chunks, but
  weaker than larger hosted models on subtle or multi-hop questions. Larger models (e.g. `Xenova/bge-base-en-v1.5`) can be
  chosen via `EMBEDDING_MODEL`; note that some (like BGE) expect a query prefix, which this prototype does not add.
  Vectors are rebuilt at every startup, so switching embedding models can never mix incompatible vectors.
- **Ollama:** called via `/api/chat` with `temperature: 0`. Answer quality and instruction-following depend heavily on the
  model; small models may ignore "answer only from the context" more often than Claude. Startup fails fast if Ollama is
  unreachable or the model isn't pulled.
- **Multi-part questions:** splitting costs one extra chat-model call, so it is gated by a cheap heuristic and falls back to the
  normal path on any failure. The heuristic over-triggers on words like "and" (the model then returns one part, which costs a
  little time but changes nothing). Each part gets half of `top_k` (minimum 2): a full `top_k` per part pulled in loosely related chunks, which
  bloated the sources list and distracted small models. A small local model (like an 8B) may split less reliably than Claude; if the
  split looks wrong, the Vector map shows it. Where the answer to one part is simply not in the FAQs, the prompt asks the model to
  say so for that part and still answer the rest.
- **Generation:** "answer only from context" system prompt (no `temperature` is sent to Anthropic, because newer Claude models reject it; Ollama gets `temperature: 0`), excerpts labelled with filenames.
- **Reliability extras (small):** 30s per-call timeout, retry with exponential backoff on network errors / 429 / 5xx
  (not on other 4xx), one log line per request.
- **UI:** one static HTML file (with a "Reload FAQs" button that calls `POST /reload` and shows the file/chunk counts or the error) served by the same server, so it calls `/ask` same-origin (no CORS config). Vanilla JS,
  no framework or build step. Answers are inserted with `textContent` so model output can never inject HTML.
- **Uploading FAQs:** the browser reads the chosen files and sends them as JSON (`POST /faqs`) instead of multipart form
  data, which avoids a multipart parser dependency and is fine for small text files. The server accepts only plain `.md`
  names (so nothing can be written outside the FAQ folder), caps count and size, saves, then re-indexes using the same
  lock as `/reload`. If indexing fails the files are rolled back, so the folder and the index never disagree. Same-name
  uploads replace the existing file. Deleting files is not in the UI (remove them from the folder and click Reload FAQs).
  Like `/reload`, the endpoint has no auth: anyone who can reach the server can write `.md` files into the FAQ folder.
- **Vector map:** embeddings (e.g. 384-D) are projected to 2D with PCA, implemented in ~50 lines with no dependencies. PCA is
  deterministic (the map doesn't reshuffle between runs, unlike t-SNE/UMAP) and keeps global distances meaningful, at the cost of
  hiding finer structure. Vectors are L2-normalised first so the geometry matches cosine similarity, and the map states how much
  variance the two axes keep. The question is projected with the same fit, so it lands where its neighbours are. Treat the plot as
  intuition and the score list as ground truth. Points carry their chunk text, which is fine for a small corpus but would need paging
  or sampling for thousands of chunks. `/inspect` reuses the exact retrieval code path of `/ask` (including the two-source swap).
- **API docs:** the spec is a plain JS object (no generator or decorator library), built from the running config so limits and defaults
  can't go stale. A test calls every documented endpoint with its own example and checks the real response against the documented schema
  (and that no route is undocumented), so the docs can't quietly drift from the code. Swagger UI comes from a version-pinned CDN link rather
  than an npm package: no dependency and nothing extra to audit, at the cost of needing internet in the browser for that one page.
  Bundling `swagger-ui-dist` and serving it locally would make `/docs` work offline.
- **Most asked (SQLite):** one table, `question_stats(normalized PRIMARY KEY, display, times_asked, first_asked_at, last_asked_at)`, updated with a single
  upsert per answered question (case, spacing and trailing punctuation are ignored when matching; the latest wording is what is shown). Reading the top 2 is one
  indexed query ordered by count, then most recently asked, so ties go to the newer question. Only successfully answered questions count. It is best-effort: any
  database error is logged once and the list just goes empty, so `/ask` is never failed or slowed by it (a write is a fraction of a millisecond; the synchronous
  driver briefly blocks the event loop, which is fine at this scale). Two drivers sit behind a ~60-line adapter that uses only the calls both share
  (prepare/run/get/all, exec, close, positional `?` parameters, transactions via BEGIN/COMMIT), so SQL is parameterised and behaviour is identical.
  `better-sqlite3` is an *optional* dependency so a failed native build can't break `npm install`; the built-in driver is the safety net.
  The table is capped (1,000 questions, pruned in batches, least-asked and oldest first). Limits: counts are all-time (no decay, so an old favourite keeps its place),
  and anyone who can reach the server can inflate a count (no auth). **Privacy:** questions are stored as typed, kept on disk until you delete the file, and shown to
  every visitor, so personal details someone types could surface; `POPULAR_MIN_COUNT=2` shows only repeated questions, and `SQLITE_PATH=off` disables the feature.
- **Answer cache (SQLite):** an exact-match cache of whole answers, checked before anything else in `/ask` (so a hit skips splitting, embedding and the chat model).
  The hard problem is staleness, so correctness is built into the key rather than relying on expiry: entries are looked up under the *current* fingerprint only (a hash of
  all chunk text, embedding/chat model, chunking, splitting mode, answer length and prompts), and entries from any other fingerprint are purged when the index is rebuilt.
  The fingerprint is deterministic, so an unchanged corpus keeps its cache across restarts and unchanged reloads. A TTL and a size cap (least recently used) bound the rest.
  Failed answers are never cached, nor is an answer produced after a *transient* failure to split a multi-part question (it would freeze a worse answer for days).
  Cached hits still count towards "Most asked". Like everything SQLite here it is best-effort: a database problem is a cache miss, never an error. Trade-offs: it only
  helps when the *same* question is asked again (a semantic cache that also catches rephrasings would need an embedding lookup and a similarity threshold, and risks serving a
  wrong answer to a similar-but-different question); a cached answer is frozen wording until it expires or the content changes; the fingerprint cannot see a model re-pulled
  under the same name (Ollama tag) or changed provider-side, so use `Cache-Control: no-cache`, clear the table, or rely on the TTL; and **privacy**: questions and answers are
  stored on disk in the same SQLite file and shared between all users of the server.
- **Vector store (SQLite + sqlite-vec):** the persistent store is a *plain table* of chunks with their vectors (float32 blobs) and a per-file content hash; sqlite-vec's `vec0`
  table is a search index kept in step with it (same row ids). So persistence, incremental re-embedding and the fallback never depend on the extension, and if the extension is
  missing or fails the app still works from the same saved data. Vectors are stored L2-normalised: for unit vectors cosine similarity is `1 - distance²/2`, so sqlite-vec's default
  distance returns exactly the ranking (and the scores) the in-memory search gives; this is tested against it. An ingest re-embeds only changed files and **saves to SQLite before swapping
  the in-memory index, inside one transaction**, so a failed embedding or save leaves the old index and database as they were. The extension is *not trusted blindly*: when it loads, a
  self-test (two known vectors, one query) must give the right answer or the app falls back with the reason logged, and a search that fails later also falls back (once, with one warning).
  Extension loading is switched off again after the attempt. Details worth knowing: sqlite-vec needs integer row ids and JS drivers bind plain numbers as floats, so ids are bound as `BigInt`;
  `k` is written into the SQL as an integer literal; at most the 1,000 nearest chunks are ranked per search (the two-source rule looks for a second file within those); the in-memory copy of the
  vectors is still kept for the Vector map; and the search is exact, not approximate (sqlite-vec scans every vector, in C), which is the right trade for thousands of chunks, not millions.
  **Honest limit of this build:** the real sqlite-vec binary couldn't be installed where this was written, so the SQL that talks to it (`vec0` table, `MATCH ... AND k = ...`,
  `vec_version()`) follows its documentation and is covered by tests against a strict stand-in, plus the self-test and fallback above, but has not run against the real extension.
  Also: switching on sqlite-vec after saving without it (or editing while it was off) rebuilds its index from the saved chunks, since it could not be kept in step.
- **Status API:** a separate *process* on its own port, because a health check that lives inside the app can't report the app being down. The app has no health endpoint at all, so the status API recognises it by
  something it already serves: `GET /openapi.json` must return the FAQ RAG API's own description (so a different service on that port is not mistaken for it, and an app that is still starting, which is not
  listening yet, shows as down). The LLM is checked with read-only calls, never a prompt. Results are shared between simultaneous requests and reused for a few seconds, so a monitor polling every second does not turn into
  a call to Claude every second. The status API has its own Swagger page and OpenAPI description, generated from its running settings; they say nothing about addresses, ports or keys. It deliberately does not check the
  embedding provider or SQLite and does not judge whether a slow LLM is unhealthy beyond the per-check timeout. It is not authenticated and tells anyone who can reach port 4000 whether the app and LLM are up (never a key
  or address); on a shared network, keep it behind your firewall. Because the app no longer has `/health`, the web page now shows its "cannot reach the server" banner when its first request (the FAQ file list) fails.
  Claude's check relies on its model-listing endpoint (verified here only against a stand-in, not the live service).
- **Native `http` instead of Express:** the API is two routes, so there is no web framework dependency.
- **Not done (out of scope):** auth, rate limiting, streaming, hybrid/BM25 search, reranking, incremental re-indexing,
  conversation history.
