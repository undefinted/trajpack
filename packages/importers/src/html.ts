const ACTIVE_OR_NONCONTENT_ELEMENT = /<(script|style|template|noscript|iframe|object|embed|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/giu;
const UNCLOSED_ACTIVE_ELEMENT = /<(script|style|template|noscript|iframe|object|embed|svg|math)\b[^>]*>[\s\S]*$/giu;
const COMMENT = /<!--[\s\S]*?-->/gu;
const TAG = /<[^>]*>/gu;

const ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: "\"",
};

function decodeEntity(entity: string, value: string): string {
  if (entity === "#") {
    const codePoint = Number.parseInt(value, 10);
    return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : " ";
  }
  if (entity.toLowerCase() === "#x") {
    const codePoint = Number.parseInt(value, 16);
    return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : " ";
  }
  return ENTITIES[`${entity}${value}`.toLowerCase()] ?? `&${entity}${value};`;
}

/**
 * Produces a non-authoritative text preview without constructing or rendering a DOM.
 * The original HTML remains the raw record; this output must not be treated as a
 * sanitizer or evidence that CSS-hidden text was visible.
 */
export function extractNonExecutingHtmlPreview(html: string): string {
  return html
    .replace(ACTIVE_OR_NONCONTENT_ELEMENT, " ")
    .replace(UNCLOSED_ACTIVE_ELEMENT, " ")
    .replace(COMMENT, " ")
    .replace(TAG, " ")
    .replace(/&(#x)([0-9a-f]+);|&(#)([0-9]+);|&([a-z]+)();/giu, (_match, hex, hexValue, decimal, decimalValue, named, empty) => {
      if (hex) return decodeEntity(hex, hexValue);
      if (decimal) return decodeEntity(decimal, decimalValue);
      return decodeEntity("", `${named}${empty}`);
    })
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
