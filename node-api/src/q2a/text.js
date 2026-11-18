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

module.exports = { postText, removeUtf8mb4, strlen, stringToWords, tagstringToTags, tagsToTagstring, tagsFromInput, viewerText, emailValidate, combineNotifyEmail };
