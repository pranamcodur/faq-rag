'use strict';

const MAX_PARTS = 4;
const MAX_PART_CHARS = 300;

/**
 * Cheap gate so ordinary questions don't pay for an extra model call: two question marks,
 * a semicolon, or a joining word. False positives are harmless (the model just returns one part).
 */
const COMPOUND_RE = /\?.+\?|;|\b(and|also|plus|as well as|along with)\b/i;
const looksCompound = (question) => COMPOUND_RE.test(question);

const DECOMPOSE_PROMPT = `Split the user's question into the separate, self-contained questions it asks.
Rules:
- Each sub-question must make sense on its own: repeat any needed context instead of using words like "it" or "that".
- If the user asks only one thing, return it unchanged as a single item.
- Return at most ${MAX_PARTS} items.
- Output ONLY a JSON array of strings. No explanation and no markdown.

Example
Question: How do I enable 2FA and how many PTO days do I get?
Output: ["How do I enable 2FA?", "How many PTO days do I get?"]`;

/** Pulls a JSON array of strings out of a model reply (tolerates code fences and extra prose). Returns [] if unusable. */
function parseSubQuestions(raw) {
  const match = String(raw || '').match(/\[[\s\S]*\]/);
  if (!match) return [];
  let arr;
  try { arr = JSON.parse(match[0]); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    if (typeof item !== 'string') continue;
    const q = item.trim().slice(0, MAX_PART_CHARS);
    if (!q || seen.has(q.toLowerCase())) continue;
    seen.add(q.toLowerCase());
    out.push(q);
    if (out.length === MAX_PARTS) break;
  }
  return out;
}

module.exports = { looksCompound, parseSubQuestions, DECOMPOSE_PROMPT, MAX_PARTS };
