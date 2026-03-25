type JsonNode = Record<string, unknown>;

function generateId(): string {
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

function createSpanNode(text: string, attrs?: JsonNode[]): JsonNode {
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
function parseInlineToChildren(text: string): JsonNode[] {
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

function makeSpanLine(spans: JsonNode[]): JsonNode {
  return { '2': '2', '3': generateId(), '7': spans };
}

function createElement(typeCode?: string, attrs?: JsonNode, children?: JsonNode[]): JsonNode {
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

function createParagraph(text: string): JsonNode {
  return createElement(undefined, undefined, parseInlineToChildren(text));
}

function createHeading(text: string, level: number): JsonNode {
  return createElement('h', { l: `h${level}` }, parseInlineToChildren(text));
}

function createListItem(text: string, ordered = false, level = 1): JsonNode {
  const lt = ordered ? 'ordered' : 'unordered';
  return createElement('l', { lt, ll: level }, parseInlineToChildren(text));
}

function createCodeBlock(code: string, language = ''): JsonNode {
  const lines = code.split('\n').map((ln) => {
    const spans = [createSpanNode(ln)];
    return createElement(undefined, undefined, [makeSpanLine(spans)]);
  });
  return createElement('cd', { la: language }, lines);
}

function createQuote(text: string): JsonNode {
  const lines = text.split('\n').map((ln) => {
    return createElement(undefined, undefined, parseInlineToChildren(ln));
  });
  return createElement('q', undefined, lines);
}

function createTableCell(text: string): JsonNode {
  const spanLine = makeSpanLine([createSpanNode(text.trim())]);
  const paragraph = createElement(undefined, undefined, [spanLine]);
  return createElement('tc', undefined, [paragraph]);
}

function createTableRow(cells: string[]): JsonNode {
  const cellNodes = cells.map((c) => createTableCell(c));
  return createElement('tr', undefined, cellNodes);
}

function createTable(rows: string[][]): JsonNode {
  const colCount = Math.max(1, rows[0]?.length ?? 1);
  const normalizedRows = rows.map((r) => {
    const fixed = r.slice(0, colCount);
    while (fixed.length < colCount) fixed.push('');
    return fixed;
  });
  const rowNodes = normalizedRows.map((r) => createTableRow(r));
  const attrs = {
    version: 1,
    // Native notes include these geometry arrays; desktop rendering expects them.
    cw: Array.from({ length: colCount }, () => 120),
    rh: Array.from({ length: rowNodes.length }, () => 40),
  };
  return createElement('t', attrs, rowNodes);
}

function createImage(url: string): JsonNode {
  return createElement('im', { u: url });
}

function tryHeading(line: string): JsonNode | null {
  const m = /^(#{1,6})\s+(.+)$/.exec(line);
  const hashes = m?.[1];
  const text = m?.[2];
  if (!hashes || !text) return null;
  return createHeading(text, hashes.length);
}

function indentLevel(indent: string): number {
  if (!indent) return 1;
  const tabCount = (indent.match(/\t/g) ?? []).length;
  const spaceCount = indent.length - tabCount;
  return Math.floor(spaceCount / 2) + tabCount + 1;
}

function tryUnorderedList(line: string): JsonNode | null {
  const m = /^(\s*)[-*+]\s+(.+)$/.exec(line);
  const indent = m?.[1];
  const text = m?.[2];
  if (indent === undefined || !text) return null;
  return createListItem(text, false, indentLevel(indent));
}

function tryOrderedList(line: string): JsonNode | null {
  const m = /^(\s*)\d+\.\s+(.+)$/.exec(line);
  const indent = m?.[1];
  const text = m?.[2];
  if (indent === undefined || !text) return null;
  return createListItem(text, true, indentLevel(indent));
}

function tryImage(line: string): JsonNode | null {
  const m = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(line);
  return m?.[2] != null ? createImage(m[2]) : null;
}

function parseMarkdownLine(line: string): JsonNode {
  const trimmed = line.trimEnd();

  return (
    tryHeading(trimmed) ??
    tryUnorderedList(trimmed) ??
    tryOrderedList(trimmed) ??
    tryImage(trimmed) ??
    (/^[-*_]{3,}$/.test(trimmed) ? createParagraph('---') : createParagraph(trimmed))
  );
}

/**
 * Convert Markdown text to Youdao note JSON string.
 */
function collectCodeLines(lines: string[], start: number): { codeLines: string[]; nextI: number } {
  const codeLines: string[] = [];
  let i = start;
  while (i < lines.length) {
    const cur = lines[i];
    if (cur == null || cur.startsWith('```')) break;
    codeLines.push(cur);
    i++;
  }
  return { codeLines, nextI: i };
}

function collectQuoteLines(
  lines: string[],
  start: number,
): { quoteLines: string[]; nextI: number } {
  const quoteLines: string[] = [];
  let i = start;
  while (i < lines.length) {
    const cur = lines[i];
    if (!cur?.startsWith('>')) break;
    quoteLines.push(cur.replace(/^>\s*/, ''));
    i++;
  }
  return { quoteLines, nextI: i };
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\|[\s\-:|]+\|$/.test(line);
}

function collectTableRows(
  lines: string[],
  start: number,
): { tableRows: string[][]; nextI: number } {
  const tableRows: string[][] = [];
  const header = lines[start]?.trim();
  const separator = lines[start + 1]?.trim();
  if (
    !header ||
    !separator ||
    !header.startsWith('|') ||
    !header.endsWith('|') ||
    !isTableSeparator(separator)
  ) {
    return { tableRows, nextI: start };
  }

  tableRows.push(parseTableRow(header));
  let i = start + 2;
  while (i < lines.length) {
    const cur = lines[i]?.trim();
    if (!cur?.startsWith('|') || !cur.endsWith('|')) break;
    if (!isTableSeparator(cur)) {
      tableRows.push(parseTableRow(cur));
    }
    i++;
  }
  return { tableRows, nextI: i };
}

export function markdownToNoteJson(mdContent: string): string {
  const lines = mdContent.split('\n');
  const contentList: JsonNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;

    const codeMatch = /^```(\w*)$/.exec(line);
    if (codeMatch) {
      const { codeLines, nextI } = collectCodeLines(lines, i + 1);
      contentList.push(createCodeBlock(codeLines.join('\n'), codeMatch[1] ?? ''));
      i = nextI + 1;
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    if (line.startsWith('>')) {
      const { quoteLines, nextI } = collectQuoteLines(lines, i);
      contentList.push(createQuote(quoteLines.join('\n')));
      i = nextI;
      continue;
    }

    const trimmedLine = line.trim();
    if (trimmedLine.startsWith('|') && trimmedLine.endsWith('|')) {
      const { tableRows, nextI } = collectTableRows(lines, i);
      if (tableRows.length) {
        contentList.push(createTable(tableRows));
        i = nextI;
        continue;
      }
    }

    contentList.push(parseMarkdownLine(line));
    i++;
  }

  const docId = generateId();
  const result = {
    '2': '1',
    '3': docId,
    '4': { version: 1, incompatibleVersion: 0, fv: '0' },
    '5': contentList,
    title: '',
    __compress__: true,
  };

  return JSON.stringify(result);
}
