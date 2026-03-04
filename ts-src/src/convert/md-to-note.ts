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

function createTextNode(text: string, attrs?: JsonNode[]): JsonNode {
  const node: JsonNode = { '8': text };
  if (attrs) node['9'] = attrs;
  return node;
}

function makeTextLine(text: string): JsonNode {
  return { '2': '2', '3': generateId(), '7': [{ '8': text }] };
}

function createElement(typeCode?: string, attrs?: JsonNode, children?: JsonNode[]): JsonNode {
  const elem: JsonNode = { '3': generateId() };
  if (attrs) elem['4'] = attrs;
  if (children !== undefined) elem['5'] = children;
  if (typeCode) elem['6'] = typeCode;
  return elem;
}

function createParagraph(text: string): JsonNode {
  const node = createTextNode(text);
  return createElement(undefined, undefined, [{ '2': '2', '3': generateId(), '7': [node] }]);
}

function createHeading(text: string, level: number): JsonNode {
  return createElement('h', { l: `h${level}` }, [makeTextLine(text)]);
}

function createListItem(text: string, ordered = false, level = 1): JsonNode {
  const lt = ordered ? 'ordered' : 'unordered';
  return createElement('l', { lt, ll: level }, [makeTextLine(text)]);
}

function createCodeBlock(code: string, language = ''): JsonNode {
  const lines = code
    .split('\n')
    .map((ln) => createElement(undefined, undefined, [makeTextLine(ln)]));
  return createElement('cd', { la: language }, lines);
}

function createQuote(text: string): JsonNode {
  const lines = text
    .split('\n')
    .map((ln) => createElement(undefined, undefined, [makeTextLine(ln)]));
  return createElement('q', undefined, lines);
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

function tryUnorderedList(line: string): JsonNode | null {
  const m = /^(\s*)[-*+]\s+(.+)$/.exec(line);
  const indent = m?.[1];
  const text = m?.[2];
  if (indent === undefined || !text) return null;
  const level = indent.length ? Math.floor(indent.length / 2) + 1 : 1;
  return createListItem(text, false, level);
}

function tryOrderedList(line: string): JsonNode | null {
  const m = /^(\s*)\d+\.\s+(.+)$/.exec(line);
  const indent = m?.[1];
  const text = m?.[2];
  if (indent === undefined || !text) return null;
  const level = indent.length ? Math.floor(indent.length / 2) + 1 : 1;
  return createListItem(text, true, level);
}

function tryQuote(line: string): JsonNode | null {
  const m = /^>\s*(.*)$/.exec(line);
  return m?.[1] != null ? createQuote(m[1]) : null;
}

function tryImage(line: string): JsonNode | null {
  const m = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(line);
  return m?.[2] != null ? createImage(m[2]) : null;
}

function parseMarkdownLine(line: string): JsonNode {
  const trimmed = line.trimEnd();
  if (!trimmed) return createParagraph('');

  return (
    tryHeading(trimmed) ??
    tryUnorderedList(trimmed) ??
    tryOrderedList(trimmed) ??
    tryQuote(trimmed) ??
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

    if (line.startsWith('>')) {
      const { quoteLines, nextI } = collectQuoteLines(lines, i);
      contentList.push(createQuote(quoteLines.join('\n')));
      i = nextI;
      continue;
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
