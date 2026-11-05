export const normalizeQuestion = (value) =>
  String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9:]+/g, ' ')
    .trim();
const words = { one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, twenty: 20 };
export function questionPeriod(text, context = {}) {
  const directional = [
    ...String(text).matchAll(
      /\bfrom\s+(19\d{2}|20\d{2}|2100)\s+(?:to|through|until)\s+(19\d{2}|20\d{2}|2100)\b/gi,
    ),
  ];
  const years = [...String(text).matchAll(/\b(19\d{2}|20\d{2}|2100)\b/g)].map((match) =>
    Number(match[1]),
  );
  if (years.length)
    return {
      fromYear: Math.min(...years),
      toYear: Math.max(...years),
      explicit: true,
      inverted: directional.some((match) => Number(match[1]) > Number(match[2])),
      disjoint:
        years.length > 1 &&
        !/\b(between|from|through|to)\b/i.test(text) &&
        /\b(?:19\d{2}|20\d{2})\s*(?:,|and|&)\s*(?:19\d{2}|20\d{2})\b/i.test(text),
    };
  const currentYear = context.currentYear || new Date().getUTCFullYear();
  if (/\bthis\s+(?:year|season)\b/i.test(text))
    return { fromYear: currentYear, toYear: currentYear, explicit: true };
  if (/\blast\s+(?:year|season)\b/i.test(text))
    return { fromYear: currentYear - 1, toYear: currentYear - 1, explicit: true };
  const last = String(text).match(
    /\b(?:last|past|previous)\s+(\d+|one|two|three|four|five|ten|twenty)\s+(?:completed\s+)?(?:years?|seasons?)\b/i,
  );
  if (last) {
    const count = Number(last[1]) || words[last[1].toLowerCase()];
    return { fromYear: currentYear - count, toYear: currentYear - 1, explicit: true };
  }
  return { fromYear: null, toYear: null, explicit: false };
}
