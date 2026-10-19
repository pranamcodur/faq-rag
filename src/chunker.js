'use strict';

/**
 * Split text into ~`size`-character chunks on word boundaries, with a small
 * word-aligned overlap so a fact straddling a boundary appears whole in at
 * least one chunk. Chunks never exceed `size` unless a single word does.
 */
function chunkText(text, size = 200, overlap = 30) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const chunks = [];
  let i = 0;
  while (i < words.length) {
    let j = i;
    let len = 0;
    // always take at least one word; then keep adding while it fits
    while (j < words.length) {
      const add = (len === 0 ? 0 : 1) + words[j].length;
      if (len > 0 && len + add > size) break;
      len += add;
      j++;
    }
    chunks.push(words.slice(i, j).join(' '));
    if (j >= words.length) break;
    // step back over trailing words totalling <= overlap chars (always advance)
    let back = j;
    let olen = 0;
    while (back > i + 1 && olen + words[back - 1].length + 1 <= overlap) {
      olen += words[back - 1].length + 1;
      back--;
    }
    i = back;
  }
  return chunks;
}

module.exports = { chunkText };
