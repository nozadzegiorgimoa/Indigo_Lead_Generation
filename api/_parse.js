// Rule-based extraction of structured fields from a free-text lead comment.
// Deliberately conservative: it fills fields it is confident about and leaves
// the rest in `additionalComment`. Designed to be swapped/augmented later with
// an LLM fallback behind the same signature (parseComment -> result object).
const { analyzePhone } = require('./_phone');
const { detectSource, stripSourceMentions } = require('./_sources');

// Tokens that should never be part of a name (sources, channels, connectors,
// customer-type words) — used to stop name capture and to clean the leftover.
const STOP_WORD = /(facebook|fb|insta(gram)?|ig|whats\s*app|whatsapp|votsap|viber|tik\s*tok|tiktok|meta|lead|form|retail|dealer|call|number|tel|mob|ფეისბუ|ფბ|ინსტა|ვოთსაფ|ვოცაფ|ვაცაპ|ვაცაფ|ვაიბერ|ტი[კქ]ტო[კქ]|ლიდი|სადილერო|საცალო|რითეილ|დილერ|ზარი|დარეკ|საიტ|ნომერი|ნომ|მობ|ტელ)/iu;

// Known Georgian cities (extend as needed). Used only for explicit mentions.
// Georgian glues suffixes, and \b is not Unicode-aware, so use a leading
// letter-boundary and prefix-match (e.g. "ქუთაისი", "ქუთაისიდან" both hit).
const CITY_HINTS = [
  { city: 'Tbilisi',  re: /(?<![\p{L}])(tbilisi|თბილის)/iu },
  { city: 'Batumi',   re: /(?<![\p{L}])(batumi|ბათუმ)/iu },
  { city: 'Kutaisi',  re: /(?<![\p{L}])(kutaisi|ქუთაის)/iu },
  { city: 'Rustavi',  re: /(?<![\p{L}])(rustavi|რუსთავ)/iu },
  { city: 'Gori',     re: /(?<![\p{L}])(gori|გორი)/iu },
  { city: 'Marneuli', re: /(?<![\p{L}])(marneuli|მარნეულ)/iu },
  { city: 'Zugdidi',  re: /(?<![\p{L}])(zugdidi|ზუგდიდ)/iu },
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
const SMS_MARK = /(?:^|[\s\n])(?:sms|სმს)\s*[:：]?\s*/i;
function extractSmsTail(text) {
  const m = new RegExp(SMS_MARK.source + '([\\s\\S]*)$', 'i').exec(text);
  return m && m[1] ? m[1].trim() : null;
}

const PHONE_RUN = /[+(]?\d[\d\s().-]{3,}\d/g;   // phone-like digit runs

function isCityToken(tok) {
  for (const h of CITY_HINTS) if (h.re.test(tok)) return true;
  return false;
}

// Pull leading name tokens from ONE line: after removing any phone run, take
// 1-3 consecutive letter-words, stopping at a source/type/connector/city word.
function nameTokensFrom(line) {
  const noPhone = line.replace(PHONE_RUN, ' ').trim();
  if (!noPhone) return null;
  const toks = noPhone.split(/[\s,]+/).filter(Boolean);
  const nameToks = [];
  for (const raw of toks) {
    const tok = raw.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');   // trim non-letters
    if (!tok || !/\p{L}/u.test(tok)) break;
    if (STOP_WORD.test(tok) || isCityToken(tok)) break;
    nameToks.push(tok);
    if (nameToks.length >= 3) break;                          // first (+patronymic) + surname
  }
  return nameToks.length ? nameToks.join(' ') : null;
}

// Heuristic name: leads come both inline (name before the phone/source) and
// field-per-line (name on its own row). Scan every line and take the first that
// yields a plausible name — header rows (source/type), the phone row, the city
// row and the sms tail are skipped.
function guessName(text) {
  if (!text) return null;
  const lines = text.split(/[\r\n;|]+/).map(s => s.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^\s*(sms|სმს)\b/i.test(line)) continue;             // sms tail line
    const nm = nameTokensFrom(line);
    if (nm && nm.length >= 2) return nm;
  }
  return null;
}

// Build the leftover comment: strip the phone, recognised source words, the
// customer-type words and the guessed name; keep the rest, and append the SMS
// tail (marker word removed).
function buildAdditional(text, { name }) {
  const smsTail = extractSmsTail(text);
  let rest = text.replace(new RegExp(SMS_MARK.source + '[\\s\\S]*$', 'i'), ' ');
  rest = rest.replace(PHONE_RUN, ' ');
  rest = stripSourceMentions(rest);
  rest = rest.replace(/(სადილერო|საცალო|რითეილ|დილერ|retail|dealer|b2b|b2c)/giu, ' ');
  rest = rest.replace(/(?<![\p{L}])(ნომერი|ნომ|number|tel|mob|ლიდი)\p{L}*/giu, ' ');   // connector words
  for (const h of CITY_HINTS) rest = rest.replace(new RegExp(h.re.source + '\\p{L}*', 'giu'), ' ');  // drop city word
  if (name) for (const part of name.split(/\s+/)) rest = rest.replace(new RegExp('(^|\\P{L})' + escapeRe(part) + '(\\P{L}|$)', 'giu'), ' ');
  rest = rest.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').replace(/^[\s,;.\-–—:]+|[\s,;.\-–—:]+$/g, '').trim();
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
