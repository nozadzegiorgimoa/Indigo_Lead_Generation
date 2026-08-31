// Rule-based extraction of structured fields from a free-text lead comment.
// Deliberately conservative: it fills fields it is confident about and leaves
// the rest in `additionalComment`. Designed to be swapped/augmented later with
// an LLM fallback behind the same signature (parseComment -> result object).
const { analyzePhone } = require('./_phone');
const { detectSource, stripSourceMentions } = require('./_sources');

// Tokens that should never be part of a name (sources, channels, connectors,
// customer-type words) — used to stop name capture and to clean the leftover.
const STOP_WORD = /(facebook|fb|insta(gram)?|ig|whats\s*app|whatsapp|votsap|viber|tik\s*tok|tiktok|meta|lead|form|retail|dealer|call|number|tel|mob|ფეისბუ|ფბ|ინსტა|ვოთსაფ|ვაცაპ|ვაიბერ|ტი[კქ]ტო[კქ]|სადილერო|საცალო|რითეილ|დილერ|ზარი|დარეკ|საიტ|ნომერი|ნომ|მობ|ტელ)/iu;

// Known Georgian cities (extend as needed). Used only for explicit mentions.
const CITY_HINTS = [
  { city: 'Tbilisi', re: /\b(tbilisi|თბილის)/i },
  { city: 'Batumi',  re: /\b(batumi|ბათუმ)/i },
  { city: 'Kutaisi', re: /\b(kutaisi|ქუთაის)/i },
  { city: 'Rustavi', re: /\b(rustavi|რუსთავ)/i },
  { city: 'Gori',    re: /\b(gori|გორ)\b/i },
  { city: 'Marneuli',re: /\b(marneuli|მარნეულ)/i },
];

function detectCustomerType(text) {
  if (!text) return null;
  if (/(სადილერო|დილერ|dealer|b2b)/i.test(text)) return 'dealer';
  if (/(საცალო|რითეილ|retail|b2c)/i.test(text)) return 'retail';
  return null;
}

function detectCity(text) {
  if (!text) return null;
  for (const h of CITY_HINTS) if (h.re.test(text)) return h.city;
  return null;
}

// Pull the tail after an "sms"/"სმს" marker (keep the text, drop the marker word).
function extractSmsTail(text) {
  const m = /\b(sms|სმს)\b[\s:—\-]*([\s\S]*)$/i.exec(text);
  return m && m[2] ? m[2].trim() : null;
}

const PHONE_RUN = /[+(]?\d[\d\s().-]{3,}\d/g;   // phone-like digit runs

// Heuristic name: the leading 1-2 alphabetic words (Latin or Georgian), before
// any phone run, source word, connector or punctuation. Low-confidence by
// nature; the operator can correct it in the full form.
function guessName(text) {
  if (!text) return null;
  const firstLine = text.split(/[\n;|]/)[0];
  const cleaned = firstLine.replace(PHONE_RUN, ' ').trim();
  const tokens = cleaned.split(/[\s,]+/).filter(Boolean);
  const nameTokens = [];
  for (const raw of tokens) {
    const tok = raw.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');  // trim non-letters
    if (!tok) break;
    if (!/\p{L}/u.test(tok)) break;
    if (STOP_WORD.test(tok)) break;
    nameTokens.push(tok);
    if (nameTokens.length >= 2) break;                       // name + surname
  }
  const name = nameTokens.join(' ').trim();
  return name.length >= 2 ? name : null;
}

// Build the leftover comment: strip the phone, recognised source words, the
// customer-type words and the guessed name; keep the rest, and append the SMS
// tail (marker word removed).
function buildAdditional(text, { name }) {
  const smsTail = extractSmsTail(text);
  let rest = text.replace(/(?:^|\s)(sms|სმს)\b[\s:：—\-]*[\s\S]*$/i, ' ');
  rest = rest.replace(PHONE_RUN, ' ');
  rest = stripSourceMentions(rest);
  rest = rest.replace(/(სადილერო|საცალო|რითეილ|დილერ|retail|dealer|b2b|b2c)/giu, ' ');
  rest = rest.replace(/(?<![\p{L}])(ნომერი|ნომ|number|tel|mob)\p{L}*/giu, ' ');   // connector words
  if (name) for (const part of name.split(/\s+/)) rest = rest.replace(new RegExp('(^|\\P{L})' + escapeRe(part) + '(\\P{L}|$)', 'giu'), ' ');
  rest = rest.replace(/\s{2,}/g, ' ').replace(/^[\s,;.\-–—:]+|[\s,;.\-–—:]+$/g, '').trim();
  const parts = [];
  if (rest) parts.push(rest);
  if (smsTail) parts.push(smsTail);
  const joined = parts.join(' · ').trim();
  return joined || null;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Main entry point.
// opts.defaultCountry: ISO2 used when a bare (no +) number is found.
function parseComment(text, opts = {}) {
  const src = (text == null ? '' : String(text)).trim();
  const empty = {
    name: null, phone: null, phoneInfo: null, country: null, city: null,
    source: null, customerType: null, additionalComment: null,
  };
  if (!src) return empty;

  const phoneInfo = analyzePhone(src, opts.defaultCountry || 'GE');
  const phoneRaw = phoneInfo.found ? (phoneInfo.raw && phoneInfo.e164 ? phoneInfo.e164 : null) : null;

  const name = guessName(src);
  const source = detectSource(src);
  const customerType = detectCustomerType(src);
  const city = detectCity(src);
  const country = phoneInfo.countryName || null;

  return {
    name,
    phone: phoneInfo.e164 || (phoneInfo.found ? phoneInfo.raw : null),
    phoneInfo,
    country,
    city,
    source,
    customerType,
    additionalComment: buildAdditional(src, { name, phoneRaw: phoneInfo.raw, source }),
  };
}

module.exports = { parseComment, detectCustomerType, detectCity, extractSmsTail, guessName };
