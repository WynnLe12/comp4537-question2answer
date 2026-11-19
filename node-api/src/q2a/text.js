// Ports of Q2A's string helpers used by posting (qa-include/util/string.php, app/format.php,
// plugins/qa-viewer-basic.php). utf8-punctuation.json is generated from $qa_utf8punctuation.
const isEmail = require('validator/lib/isEmail');
const punctuation = require('../data/utf8-punctuation.json');

// qa_post_text(): trim PHP's ASCII whitespace and normalize CRLF/CR to LF.
function postText(value) {
  if (value === undefined || value === null) return null;
  return String(value).replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '').replace(/\r\n?/g, '\n');
}

// qa_remove_utf8mb4(): drop characters outside the Basic Multilingual Plane (the tables are utf8mb3).
const removeUtf8mb4 = value => [...String(value ?? '')].filter(c => c.codePointAt(0) <= 0xffff).join('');

// qa_strlen(): mb_strlen counts code points, not UTF-16 units.
const strlen = value => [...String(value ?? '')].length;

// QA_PREG_INDEX_WORD_SEPARATOR and QA_PREG_CJK_IDEOGRAPHS_UTF8 (the byte ranges converted to code points).
const SEPARATOR = String.raw`[\n\r\t !"'()*+,./:;<=>?\[\\\]^${'`'}{|}~]`;
const CJK = /[฀-๿⺀-⿿　-〿㈀-㿿䀀-鿿豈-﫿\u{20000}-\u{2FFFF}]/gu;
// PHP runs these patterns without the u flag, where \s is only ASCII whitespace.
const NOT_SPACE = '[^\\t\\n\\v\\f\\r ]';

// qa_string_to_words() with $delimiters = false.
function stringToWords(input, { tolowercase = true, splitideographs = true, splithyphens = true } = {}) {
  let string = String(input ?? '');
  if (tolowercase) string = string.toLowerCase();
  string = [...string].map(c => punctuation[c] ?? c).join('');
  string = string.replace(new RegExp(`(${NOT_SPACE})'(${NOT_SPACE})`, 'g'), '$1$2');
  if (splitideographs) string = string.replace(CJK, ' $& ');
  const separator = new RegExp(`(?:${SEPARATOR}${splithyphens ? '|-' : ''})+`);
  return string.split(separator).filter(word => word !== '');
}

// QA_PREG_BLOCK_WORD_SEPARATOR
const BLOCK_SEPARATOR = String.raw`[\n\r\t !"\\'()+,./:;<=>?\[\\\]^${'`'}{|}~$&\-_#%@]`;
const isCjk = c => new RegExp(CJK.source, 'u').test(c);

// qa_block_words_to_preg() and qa_block_words_match_all(): whether $string contains any of the
// words in a block list such as the block_bad_usernames option (* matches within a word).
function blockWordsMatch(string, wordsOption) {
  const words = String(wordsOption ?? '').split(new RegExp(`${BLOCK_SEPARATOR}+`)).filter(Boolean);
  if (!words.length) return false;
  const patterns = words.map(word => {
    let pattern = word.toLowerCase().replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/\\\*/g, '[^ ]*');
    if (!isCjk([...word][0])) pattern = `(?<= )${pattern}`;
    if (!isCjk([...word].at(-1))) pattern = `${pattern}(?= )`;
    return pattern;
  });
  const cleaned = [...String(string).toLowerCase()].map(c => (punctuation[c] !== undefined ? ' ' : c)).join('').replace(new RegExp(BLOCK_SEPARATOR, 'g'), ' ');
  return new RegExp(patterns.join('|'), 'u').test(` ${cleaned} `);
}

// qa_block_words_replace(): each blocked word replaced by as many * as it has characters.
function blockWordsReplace(string, wordsOption) {
  string = String(string ?? '');
  const words = String(wordsOption ?? '').split(new RegExp(`${BLOCK_SEPARATOR}+`)).filter(Boolean);
  if (!words.length) return string;
  const patterns = words.map(word => {
    let pattern = word.toLowerCase().replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/\\\*/g, '[^ ]*');
    if (!isCjk([...word][0])) pattern = `(?<= )${pattern}`;
    if (!isCjk([...word].at(-1))) pattern = `${pattern}(?= )`;
    return pattern;
  });
  // Punctuation and separators become spaces of the same length, so positions line up with the original.
  const cleaned = [...string.toLowerCase()].map(c => (punctuation[c] !== undefined ? ' '.repeat(c.length) : c)).join('').replace(new RegExp(BLOCK_SEPARATOR, 'g'), ' ');
  const matches = [...` ${cleaned} `.matchAll(new RegExp(patterns.join('|'), 'gu'))].map(m => [m.index - 1, m[0].length]);
  for (const [start, length] of matches.reverse()) {
    string = string.slice(0, start) + '*'.repeat([...string.slice(start, start + length)].length) + string.slice(start + length);
  }
  return string;
}

// qa_slugify(): the title's words joined by hyphens, longest words kept first within maxLength,
// and with asciiOnly accents converted and anything else outside [ a-zA-Z0-9-] removed.
function slugify(string, asciiOnly = true, maxLength = null) {
  const accents = require('../data/utf8-remove-accents.json');
  const words = stringToWords(string, { tolowercase: true, splitideographs: false, splithyphens: true });
  let keep = words.map(() => true);
  if (maxLength !== null && !Number.isNaN(maxLength)) {
    const lengths = words.map(word => strlen(word));
    if (lengths.reduce((a, b) => a + b, 0) > maxLength) {
      let remaining = maxLength;
      // arsort(): longest first, ties in their original order
      for (const index of lengths.map((length, i) => i).sort((a, b) => lengths[b] - lengths[a] || a - b)) {
        if (remaining > 0) remaining -= lengths[index];
        else keep[index] = false;
      }
    }
  }
  let slug = words.filter((word, i) => keep[i]).join('-');
  if (asciiOnly) {
    slug = [...slug].map(c => accents[c] ?? c).join('').replace(/[^ a-zA-Z0-9-]/g, '').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
  }
  return slug;
}

// qa_random_alphanum(): base-36 digits in groups of three.
function randomAlphanum(length) {
  const { randomInt } = require('node:crypto');
  let string = '';
  while (string.length < length) string += randomInt(0, 46656).toString(36).padStart(3, '0');
  return string.slice(0, length);
}

const tagstringToTags = tagstring => (tagstring ? String(tagstring).split(',') : []);
const tagsToTagstring = tags => tags.join(',');

// qa_get_tags_field_value(): the tag field as typed, split into normalized unique tags.
function tagsFromInput(value, commaSeparated) {
  const text = removeUtf8mb4(postText(value) ?? '');
  const tags = commaSeparated
    ? text.replace(/\//g, ' ').toLowerCase().trim().split(/\s*,\s*/).filter(Boolean)
    : stringToWords(text, { splitideographs: false, splithyphens: false });
  return [...new Set(tags)];
}

const LINE = 'br|option';
const PARAGRAPH = 'address|applet|blockquote|center|cite|col|div|dd|dl|dt|embed|form|frame|frameset|h1|h2|h3|h4|h5|h6' +
  '|hr|iframe|input|li|marquee|ol|p|pre|samp|select|spacer|table|tbody|td|textarea|tfoot|th|thead|tr|ul';
const ENTITIES = { '&#34;': '"', '&#38;': '&', '&#39;': "'", '&#60;': '<', '&#62;': '>', '&nbsp;': ' ', '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>' };

// qa_viewer_text() through the basic viewer: plain text is kept, HTML is flattened to text.
function viewerText(content, format) {
  if (format === '') return content;
  if (format !== 'html') return `[no viewer found for format: ${format}]`;
  let text = String(content).replace(/[\n\r\t]/g, ' ');
  text = text.replace(new RegExp(`<\\s*(${LINE})[^A-Za-z0-9]`, 'gi'), '\n$&');
  text = text.replace(new RegExp(`<\\s*(${PARAGRAPH})[^A-Za-z0-9]`, 'gi'), '\n\n$&');
  text = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ''); // strip_tags()
  text = text.replace(/ {2,}/g, ' ').replace(/ *\n */g, '\n').replace(/\n\n\n+/g, '\n\n');
  text = text.replace(/&#34;|&#38;|&#39;|&#60;|&#62;|&nbsp;|&quot;|&amp;|&lt;|&gt;/g, entity => ENTITIES[entity]);
  return text.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');
}

// qa_email_validate() uses PHP's FILTER_VALIDATE_EMAIL; validator's ASCII rules are the closest match.
const emailValidate = email => isEmail(String(email), { allow_utf8_local_part: false, allow_ip_domain: true });

// qa_combine_notify_email()
const combineNotifyEmail = (userid, notify, email) => (notify ? (email ? email : (userid !== null && userid !== undefined ? '@' : null)) : null);

module.exports = { blockWordsMatch, blockWordsReplace, slugify, randomAlphanum, postText, removeUtf8mb4, strlen, stringToWords, tagstringToTags, tagsToTagstring, tagsFromInput, viewerText, emailValidate, combineNotifyEmail };
