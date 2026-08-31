// Phone parsing/validation/normalisation via libphonenumber-js.
// Detects the country from the international code AND validates the national
// number length/prefix (so e.g. +99555562929 is correctly rejected for GE).
const { parsePhoneNumberFromString, findPhoneNumbersInText } = require('libphonenumber-js');

// ISO country code -> display names (English + Georgian). Extend as needed;
// countries outside this map fall back to the ISO code.
const COUNTRY_NAMES = {
  GE: { en: 'Georgia',     ka: 'საქართველო' },
  RU: { en: 'Russia',      ka: 'რუსეთი' },
  KZ: { en: 'Kazakhstan',  ka: 'ყაზახეთი' },
  UA: { en: 'Ukraine',     ka: 'უკრაინა' },
  KG: { en: 'Kyrgyzstan',  ka: 'ყირგიზეთი' },
  AZ: { en: 'Azerbaijan',  ka: 'აზერბაიჯანი' },
  UZ: { en: 'Uzbekistan',  ka: 'უზბეკეთი' },
  US: { en: 'USA',         ka: 'აშშ' },
  AM: { en: 'Armenia',     ka: 'სომხეთი' },
  TR: { en: 'Turkey',      ka: 'თურქეთი' },
};

function countryName(iso, lang) {
  const n = COUNTRY_NAMES[iso];
  if (!n) return iso || null;
  return (lang === 'ka' ? n.ka : n.en) || n.en;
}

// Digits-only canonical form for duplicate matching. Valid numbers use E.164
// digits (no +); otherwise we keep the raw digits so partial numbers still
// compare consistently (e.g. 599000000 vs +995599000000 both -> 995599000000
// only when valid; invalid ones compare on their bare digits).
function normalizeDigits(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D+/g, '');
  return d || null;
}

// Analyse a phone value that may be embedded in free text.
// defaultCountry: ISO2 assumed when the number has no + prefix (default GE).
function analyzePhone(input, defaultCountry = 'GE') {
  const raw = (input == null ? '' : String(input)).trim();
  if (!raw) return { found: false, valid: false, raw: '', normalized: null, country: null, countryName: null, e164: null };

  // Try a direct parse first, then fall back to scanning free text.
  let pn = parsePhoneNumberFromString(raw, defaultCountry);
  if (!pn) {
    const hits = findPhoneNumbersInText(raw, defaultCountry);
    if (hits && hits.length) pn = hits[0].number;
  }

  if (!pn) {
    // No parseable number, but there may still be digits (invalid/partial).
    const digits = normalizeDigits(raw);
    return {
      found: !!digits, valid: false, raw,
      normalized: digits, country: null, countryName: null, e164: null,
    };
  }

  const valid = pn.isValid();
  return {
    found: true,
    valid,
    raw,
    e164: pn.number,                                   // +995...
    normalized: valid ? pn.number.replace(/\D+/g, '')  // canonical when valid
                      : normalizeDigits(pn.number || raw),
    country: pn.country || null,                       // ISO2
    countryName: pn.country ? countryName(pn.country, 'en') : null,
    national: pn.nationalNumber || null,
  };
}

module.exports = { analyzePhone, normalizeDigits, countryName, COUNTRY_NAMES };
