import { XMLParser } from 'fast-xml-parser';

const MD_ESCAPE_RE = /[\\*_#&<>\u201c\u2019\t\r\n]/g;
const MD_ESCAPE_MAP: Record<string, string> = {
  '\\': '\\\\',
  '*': '\\*',
  _: '\\_',
  '#': '\\#',
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '\u201c': '&quot;',
  '\u2019': '&apos;',
  '\t': '&emsp;',
  '\r': '<br>',
  '\n': '<br>',
};

function encodeMd(text: string): string {
  if (!text || text === ' ') return text;
  text = text.replace(/\r\n/g, '<br>').replace(/\n\r/g, '<br>');
  return text.replace(MD_ESCAPE_RE, (ch) => MD_ESCAPE_MAP[ch] ?? ch);
}

interface XmlElement {
  ':@'?: Record<string, unknown>;
  [key: string]: unknown;
}

function extractText(val: unknown): string {
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) {
    for (const item of val) {
      if (typeof item === 'object' && item !== null && '#text' in (item as Record<string, unknown>))
        return String((item as Record<string, unknown>)['#text']);
    }
    return '';
  }
  if (typeof val === 'object' && val !== null && '#text' in (val as Record<string, unknown>)) {
    return String((val as Record<string, unknown>)['#text']);
  }
  return '';
}

function getTextByKey(children: XmlElement[], key = 'text'): string {
  for (const child of children) {
    const keys = Object.keys(child).filter((k) => k !== ':@');
    for (const k of keys) {
      if (k.includes(key)) return extractText(child[k]);
    }
  }
  return '';
}

function getChildren(element: unknown): XmlElement[] {
  if (Array.isArray(element)) return element as XmlElement[];
  if (typeof element === 'object' && element !== null) {
    const keys = Object.keys(element).filter((k) => k !== ':@' && k !== '#text');
    for (const k of keys) {
      const v = (element as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as XmlElement[];
    }
  }
  return [];
}

type Converter = (text: string, element: XmlElement, listTypes: Record<string, string>) => string;

const converters: Record<string, Converter> = {
  para: (text) => text,
  heading: (text, el) => {
    const attrs = el[':@'] ?? {};
    let level = attrs['@_level'] ?? 1;
    if (level === 'a' || level === 'b') level = 1;
    return text ? `${'#'.repeat(Number(level))} ${text}` : text;
  },
  image: (text, el) => {
    const children = getChildren(el);
    const source = getTextByKey(children, 'source');
    return `![${text}](${source})`;
  },
  attach: (_text, el) => {
    const children = getChildren(el);
    const filename = getTextByKey(children, 'filename');
    const resource = getTextByKey(children, 'resource');
    return `[${filename}](${resource})`;
  },
  code: (text, el) => {
    const children = getChildren(el);
    const lang = getTextByKey(children, 'language');
    return `\`\`\`${lang}\n${text}\`\`\``;
  },
  todo: (text) => `- [ ] ${text}`,
  quote: (text) => `> ${text}`,
  horizontal_line: () => '---',
  list_item: (text, el, listTypes) => {
    const attrs = el[':@'] ?? {};
    const listId = attrs['@_list-id'] as string;
    const type = listTypes[listId];
    return type === 'ordered' ? `1. ${text}` : `- ${text}`;
  },
  table: (_text, el) => convertTable(el),
};

function convertTable(el: XmlElement): string {
  const children = getChildren(el);
  const content = getTextByKey(children, 'content');
  try {
    const data = JSON.parse(content) as {
      widths?: unknown[];
      cells?: { value?: string }[];
    };
    const colCount = data.widths?.length ?? 0;
    if (colCount === 0) return content;

    const rows = buildTableRows(data, colCount);
    addSeparatorRow(rows, colCount);
    return rows.map((r) => `| ${r.join(' | ')} |`).join('\n') + '\n';
  } catch {
    return content || '';
  }
}

function buildTableRows(data: { cells?: { value?: string }[] }, colCount: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  for (const cell of data.cells ?? []) {
    row.push(encodeMd(cell.value ?? ''));
    if (row.length === colCount) {
      rows.push(row);
      row = [];
    }
  }
  return rows;
}

function addSeparatorRow(rows: string[][], colCount: number): void {
  const separator = Array(colCount).fill('-') as string[];
  if (rows.length === 1) {
    rows.unshift(Array(colCount).fill(' ') as string[]);
  }
  rows.splice(1, 0, separator);
}

const NS = 'http://note.youdao.com';

function extractListTypeFromItem(item: XmlElement): [string, string] | null {
  const keys = Object.keys(item).filter((k) => k !== ':@');
  for (const k of keys) {
    if (!k.includes('list')) continue;
    const attrs = item[':@'] ?? {};
    const a: Record<string, unknown> = attrs;
    const id = a['@_id'];
    const typeVal = a['@_type'];
    if (id == null || typeVal == null) return null;
    const idStr = typeof id === 'string' || typeof id === 'number' ? String(id) : '';
    const typeStr =
      typeof typeVal === 'string' || typeof typeVal === 'number' ? String(typeVal) : '';
    return idStr && typeStr ? [idStr, typeStr] : null;
  }
  return null;
}

function parseListTypes(rootChildren: XmlElement[]): Record<string, string> {
  const listTypes: Record<string, string> = {};
  const listDefs = getChildren(rootChildren[0] ?? {});
  for (const item of listDefs) {
    const pair = extractListTypeFromItem(item);
    if (pair) listTypes[pair[0]] = pair[1];
  }
  return listTypes;
}

/**
 * Convert Youdao XML note bytes to Markdown.
 */
export function xmlBytesToMarkdown(data: Buffer | Uint8Array): string {
  const parser = new XMLParser({
    ignoreAttributes: false,
    preserveOrder: true,
    trimValues: false,
  });

  const xmlStr = typeof data === 'string' ? data : Buffer.from(data).toString('utf-8');
  const parsed: unknown[] = parser.parse(xmlStr) as unknown[];

  const rootEl =
    parsed.find(
      (el) => typeof el === 'object' && el !== null && !('?xml' in (el as Record<string, unknown>)),
    ) ?? parsed[0];
  const rootChildren = getChildren(rootEl);
  const listTypes = parseListTypes(rootChildren);
  const bodyChildren = getChildren(rootChildren[1] ?? {});
  const result: string[] = [];

  for (const element of bodyChildren) {
    const children = getChildren(element);
    const text = getTextByKey(children);
    const keys = Object.keys(element).filter((k) => k !== ':@');
    const tagName = keys[0] ?? '';
    const name = tagName
      .replace(`${NS}:`, '')
      .replace(/{[^}]+}/, '')
      .replace(/-/g, '_');

    const converter = converters[name];
    if (converter) {
      result.push(converter(text, element, listTypes));
    } else {
      result.push(text);
    }
  }

  return result.join('\n\n');
}
