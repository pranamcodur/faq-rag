'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_UPLOAD_FILES = 20;
const MAX_FILE_BYTES = 200 * 1024; // per file
const MAX_UPLOAD_BODY_BYTES = 8 * 1024 * 1024; // JSON body for a whole upload
// Plain file names only: letters/digits first, then letters, digits, space, _ . ( ) -, ending in .md
const FILE_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.()-]{0,98}\.md$/iu;

class UploadError extends Error {}

/** Validates the POST /faqs body; returns [{name, content}] or throws UploadError (-> 400). */
function validateUpload(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new UploadError('Body must be a JSON object');
  const { files } = body;
  if (!Array.isArray(files) || files.length === 0) throw new UploadError('"files" must be a non-empty array');
  if (files.length > MAX_UPLOAD_FILES) throw new UploadError(`At most ${MAX_UPLOAD_FILES} files per upload`);

  const seen = new Set();
  return files.map((f, i) => {
    if (f === null || typeof f !== 'object') throw new UploadError(`files[${i}] must be an object with "name" and "content"`);
    const { name, content } = f;
    if (typeof name !== 'string' || !FILE_NAME_RE.test(name) || name.includes('..')) {
      throw new UploadError(`Invalid file name ${JSON.stringify(String(name)).slice(0, 80)}: use a plain name ending in .md (letters, digits, spaces, _ . ( ) -)`);
    }
    if (seen.has(name.toLowerCase())) throw new UploadError(`Duplicate file name in upload: ${name}`);
    seen.add(name.toLowerCase());
    if (typeof content !== 'string' || content.trim() === '') throw new UploadError(`${name}: content must be a non-empty string`);
    if (content.includes('\u0000')) throw new UploadError(`${name}: does not look like a text file`);
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new UploadError(`${name}: larger than ${MAX_FILE_BYTES / 1024} KB`);
    return { name, content };
  });
}

async function listFaqFiles(dir) {
  return (await fs.readdir(dir)).filter((f) => f.toLowerCase().endsWith('.md')).sort();
}

/**
 * Writes the files into `dir`. Returns { saved, rollback }: `rollback()` restores replaced files
 * and removes newly added ones, so a failed re-index leaves disk exactly as it was.
 */
async function writeFaqFiles(dir, files) {
  const previous = new Map(); // name -> old content, or null if the file is new
  for (const { name } of files) {
    try { previous.set(name, await fs.readFile(path.join(dir, name), 'utf8')); }
    catch (err) { if (err.code !== 'ENOENT') throw err; previous.set(name, null); }
  }

  const written = [];
  const rollback = async () => {
    for (const name of written) {
      const old = previous.get(name);
      if (old === null) await fs.rm(path.join(dir, name), { force: true });
      else await fs.writeFile(path.join(dir, name), old);
    }
  };

  try {
    for (const { name, content } of files) {
      await fs.writeFile(path.join(dir, name), content);
      written.push(name);
    }
  } catch (err) {
    await rollback();
    throw err;
  }
  return { saved: files.map(({ name }) => ({ name, replaced: previous.get(name) !== null })), rollback };
}

module.exports = { validateUpload, listFaqFiles, writeFaqFiles, UploadError, MAX_UPLOAD_BODY_BYTES, MAX_UPLOAD_FILES, MAX_FILE_BYTES };
