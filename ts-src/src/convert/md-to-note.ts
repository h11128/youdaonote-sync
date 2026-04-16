import { mermaidToPlantUml } from './mermaid-to-plantuml.js';
import {
  type JsonNode,
  generateId,
  createSpanNode,
  parseInlineToChildren,
  makeSpanLine,
  createElement,
} from './note-json-builders.js';

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

const DIAGRAM_LANGUAGES = new Set(['mermaid', 'plantuml', 'puml', 'uml']);

function isDiagramLanguage(lang: string): boolean {
  return DIAGRAM_LANGUAGES.has(lang.toLowerCase());
}

function createDiagramBlock(code: string, language: string): JsonNode {
  let diagramCode = code;
  if (language.toLowerCase() === 'mermaid') {
    diagramCode = mermaidToPlantUml(code);
  }
  const lines = diagramCode.split('\n').map((ln) => {
    const spans = [createSpanNode(ln)];
    return createElement('cl', undefined, [makeSpanLine(spans)]);
  });
  return createElement('diagram', { la: 'PlantUML' }, lines);
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

function tryParseCodeFence(lines: string[], i: number): { node: JsonNode; nextI: number } | null {
  const codeMatch = /^```(\w*)$/.exec(lines[i] ?? '');
  if (!codeMatch) return null;
  const lang = codeMatch[1] ?? '';
  const { codeLines, nextI } = collectCodeLines(lines, i + 1);
  const codeContent = codeLines.join('\n');
  const node = isDiagramLanguage(lang)
    ? createDiagramBlock(codeContent, lang)
    : createCodeBlock(codeContent, lang);
  return { node, nextI: nextI + 1 };
}

function tryParseQuote(lines: string[], i: number): { node: JsonNode; nextI: number } | null {
  if (!(lines[i] ?? '').startsWith('>')) return null;
  const { quoteLines, nextI } = collectQuoteLines(lines, i);
  return { node: createQuote(quoteLines.join('\n')), nextI };
}

function tryParseTable(lines: string[], i: number): { node: JsonNode; nextI: number } | null {
  const trimmed = (lines[i] ?? '').trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  const { tableRows, nextI } = collectTableRows(lines, i);
  if (!tableRows.length) return null;
  return { node: createTable(tableRows), nextI };
}

function parseBlocks(lines: string[]): JsonNode[] {
  const contentList: JsonNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;

    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = tryParseCodeFence(lines, i);
    if (fence) {
      contentList.push(fence.node);
      i = fence.nextI;
      continue;
    }

    const quote = tryParseQuote(lines, i);
    if (quote) {
      contentList.push(quote.node);
      i = quote.nextI;
      continue;
    }

    const table = tryParseTable(lines, i);
    if (table) {
      contentList.push(table.node);
      i = table.nextI;
      continue;
    }

    contentList.push(parseMarkdownLine(line));
    i++;
  }

  return contentList;
}

function wrapDocument(contentList: JsonNode[]): string {
  return JSON.stringify({
    '2': '1',
    '3': generateId(),
    '4': { version: 1, incompatibleVersion: 0, fv: '0' },
    '5': contentList,
    title: '',
    __compress__: true,
  });
}

export function markdownToNoteJson(mdContent: string): string {
  return wrapDocument(parseBlocks(mdContent.split('\n')));
}
