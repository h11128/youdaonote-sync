import { randomUUID } from 'node:crypto';

type JsonNode = Record<string, unknown>;

function generateId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let prefix = '';
  for (let i = 0; i < 4; i++) {
    prefix += chars[Math.floor(Math.random() * chars.length)];
  }
  const ts = String(Date.now()).slice(-13);
  return `${prefix}-${ts}`;
}

function createTextNode(text: string, attrs?: JsonNode[]): JsonNode {
  const node: JsonNode = { '8': text };
  if (attrs) node['9'] = attrs;
  return node;
}

function makeTextLine(text: string): JsonNode {
  return { '2': '2', '3': generateId(), '7': [{ '8': text }] };
}

function createElement(
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

function createParagraph(text: string): JsonNode {
  const node = createTextNode(text);
  return createElement(undefined, undefined, [
    { '2': '2', '3': generateId(), '7': [node] },
  ]);
}

function createHeading(text: string, level: number): JsonNode {
  return createElement('h', { l: `h${level}` }, [makeTextLine(text)]);
}

function createListItem(text: string, ordered = false, level = 1): JsonNode {
  const lt = ordered ? 'ordered' : 'unordered';
  return createElement('l', { lt, ll: level }, [makeTextLine(text)]);
}

function createCodeBlock(code: string, language = ''): JsonNode {
  const lines = code.split('\n').map((ln) =>
    createElement(undefined, undefined, [makeTextLine(ln)]),
  );
  return createElement('cd', { la: language }, lines);
}

function createQuote(text: string): JsonNode {
  const lines = text.split('\n').map((ln) =>
    createElement(undefined, undefined, [makeTextLine(ln)]),
  );
  return createElement('q', undefined, lines);
}

function createImage(url: string): JsonNode {
  return createElement('im', { u: url });
}

function parseMarkdownLine(line: string): JsonNode {
  line = line.trimEnd();

  if (!line) return createParagraph('');

  const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
  if (headingMatch) {
    return createHeading(headingMatch[2]!, headingMatch[1]!.length);
  }

  const unorderedMatch = /^(\s*)[-*+]\s+(.+)$/.exec(line);
  if (unorderedMatch) {
    const indent = unorderedMatch[1]!.length;
    const level = indent ? Math.floor(indent / 2) + 1 : 1;
    return createListItem(unorderedMatch[2]!, false, level);
  }

  const orderedMatch = /^(\s*)\d+\.\s+(.+)$/.exec(line);
  if (orderedMatch) {
    const indent = orderedMatch[1]!.length;
    const level = indent ? Math.floor(indent / 2) + 1 : 1;
    return createListItem(orderedMatch[2]!, true, level);
  }

  const quoteMatch = /^>\s*(.*)$/.exec(line);
  if (quoteMatch) {
    return createQuote(quoteMatch[1]!);
  }

  const imageMatch = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(line);
  if (imageMatch) {
    return createImage(imageMatch[2]!);
  }

  if (/^[-*_]{3,}$/.test(line)) {
    return createParagraph('---');
  }

  return createParagraph(line);
}

/**
 * Convert Markdown text to Youdao note JSON string.
 */
export function markdownToNoteJson(mdContent: string): string {
  const lines = mdContent.split('\n');
  const contentList: JsonNode[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    const codeMatch = /^```(\w*)$/.exec(line);
    if (codeMatch) {
      const language = codeMatch[1]!;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) {
        codeLines.push(lines[i]!);
        i++;
      }
      contentList.push(createCodeBlock(codeLines.join('\n'), language));
      i++; // skip closing ```
      continue;
    }

    if (line.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('>')) {
        quoteLines.push(lines[i]!.replace(/^>\s*/, ''));
        i++;
      }
      contentList.push(createQuote(quoteLines.join('\n')));
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
