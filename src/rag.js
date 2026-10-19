'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chunkText } = require('./chunker');
const { cosine } = require('./similarity');
const { fitPca } = require('./projection');
const { looksCompound, parseSubQuestions, DECOMPOSE_PROMPT } = require('./decompose');

const SYSTEM_PROMPT = `You answer questions using ONLY the provided FAQ context excerpts.
- Each excerpt is labelled with its source file name in square brackets.
- A question can have several parts. Answer every part that the context covers, one after another and briefly.
  For a part the context does not cover, say you don't have enough information in the FAQs for that part.
  Never refuse the whole question just because one part is missing.
- If nothing in the context answers the question, say you don't have enough information in the FAQs.
- Be concise. Do not invent policies, steps or numbers.
- Mention the source file names you relied on (e.g. "(see sso.md)").`;

// For multi-part questions each part retrieves its own excerpts: at least 2, or half of top_k, whichever is larger.
// (A full top_k per part pulls in loosely related chunks, which adds noise and bloats the sources list.)
// The merged context is also capped so it stays small enough for local models (Ollama's default context is ~2k tokens).
const MAX_COMPOUND_CHUNKS = 12;
const perPartShare = (topK) => Math.max(2, Math.ceil(topK / 2));

const r4 = (x) => Math.round(x * 1e4) / 1e4;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const PROMPTS_VERSION = sha256(SYSTEM_PROMPT + DECOMPOSE_PROMPT);

/**
 * @param cache  optional answer cache (src/answerCache.js). When given, a repeated question is answered from it without
 *               retrieval or a chat-model call.
 * @param store  optional vector store (src/vectorStore.js). When given, chunks and vectors are saved in SQLite: a restart
 *               re-embeds nothing, an edit re-embeds only the changed files, and (with sqlite-vec) searching happens in SQLite.
 */
function createRag(cfg, llm, { cache = null, store = null } = {}) {
  /** @type {{id:number, file:string, text:string, embedding:number[]}[]} */
  let index = [];
  let mapCache = null; // PCA fit + projected points for the current index
  let byRowid = new Map(); // store row id -> chunk, to turn sqlite-vec results back into chunks
  let fingerprintValue = null; // identifies everything a cached answer depends on (see computeFingerprint)

  /**
   * A cached answer is valid only for the same FAQ content, models and settings that produced it, so all of these go
   * into one hash: the chunk text itself (any edit changes it), the embedding and chat models, chunking, splitting mode,
   * answer length and the prompts. Unchanged files + unchanged settings give the same value after a restart, so
   * the cache survives restarts; anything else makes old entries unreachable.
   */
  function computeFingerprint(chunks) {
    return sha256(JSON.stringify({
      v: 1,
      chunks: chunks.map((c) => [c.file, c.text]),
      embedding: [cfg.embeddingProvider, cfg.embeddingModel],
      chunking: [cfg.chunkSize, cfg.chunkOverlap],
      answerer: cfg.llmProvider === 'ollama' ? ['ollama', cfg.ollamaModel] : ['anthropic', cfg.chatModel],
      decomposition: cfg.decomposition,
      maxAnswerTokens: cfg.maxAnswerTokens,
      prompts: PROMPTS_VERSION,
    }));
  }

  /** What the saved vectors depend on: the embedding model, chunking, and the format of the text that gets embedded. */
  const vectorSettingsKey = () => sha256(JSON.stringify({
    v: 1,
    embedding: [cfg.embeddingProvider, cfg.embeddingModel],
    chunking: [cfg.chunkSize, cfg.chunkOverlap],
    text: 'filename-prefix',
    vectors: 'l2-float32',
  }));

  /**
   * Read all .md files, chunk them, embed chunks (in batches), keep them in memory. The new index replaces the old one only on success.
   * With a vector store, files whose content is unchanged since they were saved are not embedded again, and the result is saved
   * to SQLite BEFORE the in-memory index is swapped, so if saving fails the previous index stays in use.
   */
  async function ingest() {
    const names = (await fs.readdir(cfg.faqDir)).filter((f) => f.toLowerCase().endsWith('.md')).sort();
    if (names.length === 0) throw new Error(`No .md files found in ${cfg.faqDir}`);

    const key = store ? vectorSettingsKey() : null;
    const saved = store ? store.load(key) : new Map();
    const files = []; // [{ file, hash, chunks: [{ text, embedding }] }]
    const pending = []; // chunks that still need an embedding
    for (const file of names) {
      const raw = await fs.readFile(path.join(cfg.faqDir, file), 'utf8');
      const hash = sha256(raw);
      const known = saved.get(file);
      if (known && known.hash === hash) { files.push({ file, hash, chunks: known.chunks }); continue; }
      const chunks = chunkText(raw, cfg.chunkSize, cfg.chunkOverlap).map((text) => ({ text, embedding: null }));
      files.push({ file, hash, chunks });
      for (const c of chunks) pending.push({ file, c });
    }

    const BATCH = 100;
    for (let i = 0; i < pending.length; i += BATCH) {
      const batch = pending.slice(i, i + BATCH);
      // Prefix the filename (sans extension) so short chunks keep topical context.
      const vectors = await llm.embed(batch.map(({ file, c }) => `${file.replace(/\.md$/i, '')}: ${c.text}`), 'document');
      batch.forEach(({ c }, k) => { c.embedding = vectors[k]; });
    }

    const rowids = store ? store.save(key, files) : null;

    const chunks = [];
    for (const f of files) {
      f.chunks.forEach((c, ord) => {
        const chunk = { file: f.file, text: c.text, embedding: c.embedding };
        if (rowids) chunk.rowid = rowids.get(f.file)[ord];
        chunks.push(chunk);
      });
    }
    chunks.forEach((c, i) => { c.id = i; });
    byRowid = new Map(chunks.filter((c) => c.rowid !== undefined).map((c) => [c.rowid, c]));
    index = chunks;
    mapCache = null;
    fingerprintValue = computeFingerprint(chunks);
    if (cache) cache.retain(fingerprintValue); // answers from the previous content/settings can never be served again
    return { files: names.length, chunks: chunks.length, embedded: pending.length, reused: chunks.length - pending.length };
  }

  /** All chunks scored against the query by cosine similarity, best first (searched inside SQLite when sqlite-vec is active). */
  function rankAll(qVec) {
    const hits = store ? store.search(qVec, index.length) : null;
    if (hits) {
      const ranked = [];
      for (const h of hits) {
        const chunk = byRowid.get(h.rowid);
        if (chunk) ranked.push({ ...chunk, score: h.score });
      }
      if (ranked.length > 0) return ranked;
    }
    return index.map((c) => ({ ...c, score: cosine(qVec, c.embedding) })).sort((a, b) => b.score - a.score);
  }

  /**
   * Top-k of `ranked`. If the top-k all come from one file but other files exist, swap the
   * lowest-ranked pick for the best chunk from another file so the answer can cite >= 2 distinct sources.
   */
  function select(ranked, topK) {
    const picked = ranked.slice(0, topK);
    const distinct = new Set(picked.map((c) => c.file));
    let swapped = false;
    if (distinct.size < 2 && topK >= 2) {
      const other = ranked.find((c) => !distinct.has(c.file));
      if (other) { picked[picked.length - 1] = other; swapped = true; }
    }
    return { picked, swapped };
  }

  /** Single-vector retrieval: embed the question as-is and take the top-k. */
  async function retrieveDetailed(question, topK) {
    const [qVec] = await llm.embed([question], 'query');
    const ranked = rankAll(qVec);
    return { qVec, ranked, ...select(ranked, topK) };
  }

  async function retrieve(question, topK) {
    return (await retrieveDetailed(question, topK)).picked;
  }

  /** Splits a multi-part question into sub-questions with the chat model. Any problem falls back to the original question. */
  async function decompose(question) {
    if (cfg.decomposition === 'off') return { subs: [question], degraded: false };
    if (cfg.decomposition === 'auto' && !looksCompound(question)) return { subs: [question], degraded: false };
    try {
      const parts = parseSubQuestions(await llm.generate(DECOMPOSE_PROMPT, question));
      return { subs: parts.length > 1 ? parts : [question], degraded: false };
    } catch (err) {
      // `degraded`: a transient failure made this a worse answer than normal, so it must not be cached
      console.warn('Question splitting failed; using the question as-is:', err.message);
      return { subs: [question], degraded: true };
    }
  }

  /**
   * Decides what to retrieve for a question.
   *  - single:   one vector for the whole question (the normal path)
   *  - compound: one vector per sub-question; each part gets its own share of excerpts, merged round-robin so no
   *              part crowds out another, de-duplicated and capped. Every chosen chunk records the part it came from.
   */
  async function plan(question, topK) {
    const { subs, degraded } = await decompose(question);

    if (subs.length < 2) {
      const d = await retrieveDetailed(question, topK);
      return {
        mode: 'single',
        subs: [question],
        qVec: d.qVec,
        partVecs: [d.qVec],
        partRankings: [d.ranked],
        perPart: topK,
        chosen: d.picked.map((c) => ({ ...c, part: 0 })),
        diversityId: d.swapped ? d.picked[d.picked.length - 1].id : null,
        degraded,
      };
    }

    const vecs = await llm.embed([question, ...subs], 'query'); // [whole question, ...parts]
    const partRankings = subs.map((_, i) => rankAll(vecs[i + 1]));
    const perPart = perPartShare(topK);
    const cap = Math.max(topK, MAX_COMPOUND_CHUNKS);

    const chosen = [];
    const seen = new Set();
    for (let round = 0; round < perPart && chosen.length < cap; round++) {
      for (let p = 0; p < partRankings.length && chosen.length < cap; p++) {
        const c = partRankings[p][round];
        if (!c || seen.has(c.id)) continue;
        seen.add(c.id);
        chosen.push({ ...c, part: p });
      }
    }

    // same two-source guarantee as the single path
    let diversityId = null;
    const files = new Set(chosen.map((c) => c.file));
    if (files.size < 2) {
      const other = partRankings[0].find((c) => !files.has(c.file));
      if (other) {
        const item = { ...other, part: 0 };
        if (chosen.length >= cap) chosen[chosen.length - 1] = item; else chosen.push(item);
        diversityId = other.id;
      }
    }

    return { mode: 'compound', subs, qVec: vecs[0], partVecs: vecs.slice(1), partRankings, perPart, chosen, diversityId, degraded: false };
  }

  function buildContext(p) {
    if (p.mode === 'single') {
      return p.chosen.map((h, i) => `[${h.file}] (excerpt ${i + 1})\n${h.text}`).join('\n\n');
    }
    let n = 0;
    return p.subs.map((sub, i) => {
      const hits = p.chosen.filter((h) => h.part === i);
      const body = hits.length ? hits.map((h) => `[${h.file}] (excerpt ${++n})\n${h.text}`).join('\n\n') : '(no excerpts found)';
      return `### Part ${i + 1}: ${sub}\n${body}`;
    }).join('\n\n');
  }

  /** @returns {{answer:string, sources:string[], cached?:boolean}} `cached` is only present when an answer cache is configured. */
  async function ask(question, topK, { bypassCache = false } = {}) {
    const fp = fingerprintValue; // the content this answer will be based on
    if (cache && fp && !bypassCache) {
      const hit = cache.get(fp, topK, question);
      if (hit) return { ...hit, cached: true };
    }

    const p = await plan(question, topK);
    const intro = p.mode === 'compound' ? 'This question has several parts. Answer each part.\n\n' : '';
    const answer = await llm.generate(SYSTEM_PROMPT, `${intro}Context:\n${buildContext(p)}\n\nQuestion: ${question}`);
    // Sources = distinct files of the chunks given to the model, in order.
    const sources = [...new Set(p.chosen.map((c) => c.file))];
    if (cache && fp && !p.degraded) cache.put(fp, topK, question, { answer, sources });
    return cache ? { answer, sources, cached: false } : { answer, sources };
  }

  // ---- inspection (read-only; used by the vector map in the UI) ----

  function getMap() {
    if (!mapCache) {
      const pca = fitPca(index.map((c) => c.embedding));
      const points = index.map((c) => {
        const [x, y] = pca.project(c.embedding);
        return { id: c.id, file: c.file, text: c.text, x: r4(x), y: r4(y) };
      });
      mapCache = { pca, points };
    }
    return mapCache;
  }

  /** Every chunk projected to 2D, plus how much of the variance the two axes keep. */
  async function map() {
    const { pca, points } = getMap();
    return {
      count: index.length,
      dimensions: pca.dimensions,
      explained_variance: pca.explained.map(r4),
      files: [...new Set(index.map((c) => c.file))].sort(),
      points,
    };
  }

  /**
   * Shows exactly what retrieval would do for a question (no answer is generated; a multi-part question
   * still uses the chat model once, to split it). `parts` has one entry for a normal question and one per
   * sub-question for a multi-part one; `question` is where the whole question's own vector lands.
   */
  async function inspect(question, topK) {
    const p = await plan(question, topK);
    const { pca } = getMap();
    const at = (v) => { const [x, y] = pca.project(v); return { x: r4(x), y: r4(y) }; };

    const usedIds = new Set(p.chosen.map((c) => c.id));
    const rowLimit = p.mode === 'single' ? Math.max(topK, 10) : Math.max(p.perPart, 5);

    const parts = p.subs.map((sub, i) => {
      const ranked = p.partRankings[i];
      const rows = ranked.slice(0, rowLimit);
      if (i === 0 && p.diversityId !== null && !rows.some((c) => c.id === p.diversityId)) {
        rows.push(ranked.find((c) => c.id === p.diversityId)); // a swapped-in chunk can sit below the cut-off
      }
      const rankOf = new Map(ranked.map((c, k) => [c.id, k + 1]));
      return {
        question: sub,
        ...at(p.partVecs[i]),
        results: rows.map((c) => ({
          rank: rankOf.get(c.id),
          id: c.id,
          file: c.file,
          text: c.text,
          score: r4(c.score),
          used: usedIds.has(c.id),
          added_for_diversity: c.id === p.diversityId,
        })),
      };
    });

    return {
      question: at(p.qVec),
      top_k: topK,
      per_part: p.perPart, // excerpts each part retrieves itself (= top_k for a normal question)
      mode: p.mode,
      sources: [...new Set(p.chosen.map((c) => c.file))],
      parts,
    };
  }

  return { ingest, retrieve, ask, map, inspect, fingerprint: () => fingerprintValue };
}

module.exports = { createRag };
