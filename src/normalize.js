'use strict';

/** Same question however it is typed: case, spacing and trailing punctuation don't matter. */
function normalizeQuestion(question) {
  return question.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[?!.,;:\s]+$/, '');
}

module.exports = { normalizeQuestion };
