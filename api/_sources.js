// Lead-source standardisation: many free-text spellings -> one canonical value.
// Rule-based (regex + dictionary). Latin tokens are letter-bounded on both
// sides; Georgian tokens are prefix-matched (Georgian glues suffixes onto the
// word, e.g. "ფეისბუქიდან"), so we only require a boundary before them.
// \p{L} + the /u flag give real Unicode letter boundaries (\b does not).

const CANONICAL_SOURCES = [
  'Website form', 'Facebook', 'Instagram', 'Meta Lead Form', 'WhatsApp',
  'Viber', 'TikTok', 'Phone call', 'Walk-in', 'Referral',
];

// Order matters: more specific first (Meta Lead Form before bare "meta").
const SOURCE_RULES = [
  { canonical: 'Meta Lead Form', re: /(?<![\p{L}])(meta\s*lead\s*form|lead\s*form|meta)(?![\p{L}])|(?<![\p{L}])(ლიდ\s*ფორმა|ლიდფორმა)/iu },
  { canonical: 'Facebook',       re: /(?<![\p{L}])(facebook|fb)(?![\p{L}])|(?<![\p{L}])(ფეისბუ|ფბ)/iu },
  { canonical: 'Instagram',      re: /(?<![\p{L}])(instagram|insta|ig)(?![\p{L}])|(?<![\p{L}])ინსტა/iu },
  { canonical: 'WhatsApp',       re: /(?<![\p{L}])(whats\s*app|whatsapp|votsap|watsap)(?![\p{L}])|(?<![\p{L}])(ვოთსაფ|ვაცაპ)/iu },
  { canonical: 'Viber',          re: /(?<![\p{L}])(viber)(?![\p{L}])|(?<![\p{L}])ვაიბერ/iu },
  { canonical: 'TikTok',         re: /(?<![\p{L}])(tik\s*tok|tiktok)(?![\p{L}])|(?<![\p{L}])ტი[კქ]ტო[კქ]/iu },
  { canonical: 'Phone call',     re: /(?<![\p{L}])(phone\s*call|call)(?![\p{L}])|(?<![\p{L}])(ზარი|დარეკ)/iu },
  { canonical: 'Walk-in',        re: /(?<![\p{L}])(walk\s*-?\s*in)(?![\p{L}])|(?<![\p{L}])ადგილზე/iu },
  { canonical: 'Referral',       re: /(?<![\p{L}])(referral)(?![\p{L}])|(?<![\p{L}])(რეკომენდაცი|მეგობ)/iu },
  { canonical: 'Website form',   re: /(?<![\p{L}])(website|web\s*form)(?![\p{L}])|(?<![\p{L}])საიტ/iu },
];

// Normalise a single explicit source value (e.g. a dropdown/free-text field).
function normalizeSource(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  const exact = CANONICAL_SOURCES.find((c) => c.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  for (const rule of SOURCE_RULES) if (rule.re.test(s)) return rule.canonical;
  return s; // unknown: keep as-is rather than lose information
}

// Detect a source mentioned anywhere inside a free-text comment.
function detectSource(text) {
  if (!text) return null;
  for (const rule of SOURCE_RULES) if (rule.re.test(text)) return rule.canonical;
  return null;
}

// Remove recognised source mentions from a comment (for building the leftover).
// For Georgian prefixes we also consume the trailing suffix letters so no
// fragment like "ქიდან" (from "ფეისბუქიდან") is left behind.
function stripSourceMentions(text) {
  if (!text) return text;
  let out = text;
  for (const rule of SOURCE_RULES) {
    // Extend any Georgian prefix in the rule to swallow trailing letters.
    const src = rule.re.source.replace(/(ფეისბუ|ფბ|ინსტა|ვოთსაფ|ვაცაპ|ვაიბერ|ტი\[კქ\]ტო\[კქ\]|ზარი|დარეკ|ადგილზე|რეკომენდაცი|მეგობ|საიტ|ლიდ\\s\*ფორმა|ლიდფორმა|ფორმა)/g, '$1\\p{L}*');
    out = out.replace(new RegExp(src, 'giu'), ' ');
  }
  return out;
}

module.exports = { CANONICAL_SOURCES, normalizeSource, detectSource, stripSourceMentions };
