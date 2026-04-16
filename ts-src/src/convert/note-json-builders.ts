export type JsonNode = Record<string, unknown>;

export function generateId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let prefix = '';
  for (let i = 0; i < 4; i++) {
    prefix += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  const ts = String(Date.now()).slice(-13);
  return prefix + '-' + ts;
}

// Inline Markdown tokens in priority order:
// 1. bold+italic (***text***), 2. bold (**text**), 3. italic (*text*),
// 4. links [text](url)
// Inline code is intentionally NOT matched — Youdao Note JSON has no inline code
// attribute, so backticks are preserved as literal text for roundtrip fidelity.
const INLINE_RE = /(\*{3})(.+?)\1|(\*{2})(.+?)\3|(\*)(.+?)\5|\[([^\]]+)\]\(([^)]+)\)/g;

interface InlineToken {
  text: string;
  bold?: boolean;
  italic?: boolean;
  href?: string;
}

function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let lastIndex = 0;

  for (const m of text.matchAll(INLINE_RE)) {
    const start = m.index;
    if (start > lastIndex) {
      tokens.push({ text: text.slice(lastIndex, start) });
    }

    if (m[1] === '***' && m[2]) {
      tokens.push({ text: m[2], bold: true, italic: true });
    } else if (m[3] === '**' && m[4]) {
      tokens.push({ text: m[4], bold: true });
    } else if (m[5] === '*' && m[6]) {
      tokens.push({ text: m[6], italic: true });
    } else if (m[7] && m[8]) {
      tokens.push({ text: m[7], href: m[8] });
    }

    lastIndex = start + m[0].length;
  }

  if (lastIndex < text.length) {
    tokens.push({ text: text.slice(lastIndex) });
  }

  return tokens;
}

export function createSpanNode(text: string, attrs?: JsonNode[]): JsonNode {
  const node: JsonNode = { '8': text };
  if (attrs?.length) node['9'] = attrs;
  return node;
}

function buildSpanAttrs(token: InlineToken): JsonNode[] | undefined {
  const attrs: JsonNode[] = [];
  if (token.bold) attrs.push({ '2': 'b' });
  if (token.italic) attrs.push({ '2': 'i' });
  return attrs.length ? attrs : undefined;
}

/**
 * Parse inline Markdown in text and return an array of children for a text line.
 * Links become `"6":"li"` child nodes; bold/italic become span attributes.
 * Plain text and inline code become simple spans.
 */
export function parseInlineToChildren(text: string): JsonNode[] {
  const tokens = tokenizeInline(text);
  if (!tokens.length) return [makeSpanLine([createSpanNode(text)])];

  const children: JsonNode[] = [];
  let pendingSpans: JsonNode[] = [];

  const flushSpans = (): void => {
    if (pendingSpans.length) {
      children.push(makeSpanLine(pendingSpans));
      pendingSpans = [];
    }
  };

  for (const token of tokens) {
    if (token.href) {
      flushSpans();
      children.push(createLinkChild(token.text, token.href));
    } else {
      pendingSpans.push(createSpanNode(token.text, buildSpanAttrs(token)));
    }
  }

  flushSpans();
  return children;
}

export function makeSpanLine(spans: JsonNode[]): JsonNode {
  return { '2': '2', '3': generateId(), '7': spans };
}

export function createElement(
  typeCode?: string,
  attrs?: JsonNode,
  children?: JsonNode[],
): JsonNode {
  const elem: JsonNode = { '3': generateId() };
  if (attrs) elem['4'] = attrs;
  if (children !== undefined) elem['5'] = children;
  if (typeCode) elem['6'] = typeCode;
  return elem;
}

function createLinkChild(text: string, url: string): JsonNode {
  const spanLine = makeSpanLine([createSpanNode(text)]);
  return { '3': generateId(), '4': { hf: url }, '5': [spanLine], '6': 'li' };
}
