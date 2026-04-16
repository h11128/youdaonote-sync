import { isMermaidConvertedPlantUml } from './mermaid-to-plantuml.js';
import type { JsonNode } from './note-json-builders.js';
import { plantumlToMermaid } from './plantuml-to-mermaid.js';

const F_ATTRS = '4';
const F_CHILDREN = '5';
const F_TYPE = '6';
const F_SPANS = '7';
const F_TEXT = '8';
const F_TEXT_ATTRS = '9';
const F_ATTR_TYPE = '2';

function getCommonText(content: JsonNode): string {
  let allText = '';
  const children = content[F_CHILDREN] as JsonNode[] | undefined;
  if (!children?.length) return allText;

  const firstChild = children[0];
  if (!firstChild) return allText;
  const spans = firstChild[F_SPANS] as JsonNode[] | undefined;
  if (!spans) return allText;

  for (const span of spans) {
    const raw = span[F_TEXT];
    const text = typeof raw === 'string' ? raw : '';
    const textAttrs = span[F_TEXT_ATTRS] as JsonNode[] | undefined;
    if (text && textAttrs) {
      allText += convertTextAttribute(text, textAttrs);
    } else {
      allText += text;
    }
  }
  return allText;
}

function convertTextAttribute(text: string, textAttrs: JsonNode[]): string {
  if (!Array.isArray(textAttrs) || !textAttrs.length || !text) return text;
  for (const attr of textAttrs) {
    const type = attr[F_ATTR_TYPE] as string;
    if (type === 'b') text = `**${text}**`;
    else if (type === 'i') text = `*${text}*`;
  }
  return text;
}

function extractTextFromSpans(spans: JsonNode[]): string {
  let text = '';
  for (const span of spans) {
    const raw = span[F_TEXT];
    const part = typeof raw === 'string' ? raw : '';
    const textAttrs = span[F_TEXT_ATTRS] as JsonNode[] | undefined;
    text += textAttrs ? convertTextAttribute(part, textAttrs) : part;
  }
  return text;
}

function convertText(content: JsonNode): string {
  let allText = '';
  const oneChildren = content[F_CHILDREN] as JsonNode[] | undefined;
  if (!oneChildren) return allText;

  for (const child of oneChildren) {
    const text = convertChildToText(child);
    if (text) allText += text;
  }
  return allText;
}

function convertChildToText(child: JsonNode): string {
  const twoChildren = child[F_CHILDREN] as JsonNode[] | undefined;
  const textType = child[F_TYPE] as string | undefined;
  const spans = child[F_SPANS] as JsonNode[] | undefined;

  if (spans && !twoChildren) {
    return extractTextFromSpans(spans);
  }
  if (textType === 'li' && twoChildren) {
    const sourceText = getCommonText(child);
    const attrs = child[F_ATTRS] as JsonNode | undefined;
    if (attrs && typeof attrs.hf === 'string') {
      return `[${sourceText}](${attrs.hf})`;
    }
  }
  return '';
}

function safeStr(val: unknown): string {
  return typeof val === 'string' ? val : '';
}

function convertHeading(content: JsonNode): string {
  const attrs = (content[F_ATTRS] as JsonNode | undefined) ?? {};
  const typeName = attrs.l as string | undefined;
  let text = convertText(content);
  if (text && typeName) {
    const levelStr = typeName.replace('h', '');
    const level = parseInt(levelStr, 10) || 1;
    text = `${'#'.repeat(level)} ${text}`;
  }
  return text;
}

function convertImage(content: JsonNode): string {
  const attrs = (content[F_ATTRS] as JsonNode | undefined) ?? {};
  return `![](${safeStr(attrs.u)})`;
}

function convertAttach(content: JsonNode): string {
  const attrs = (content[F_ATTRS] as JsonNode | undefined) ?? {};
  return `[${safeStr(attrs.fn)}](${safeStr(attrs.re)})`;
}

function convertCode(content: JsonNode): string {
  const attrs = (content[F_ATTRS] as JsonNode | undefined) ?? {};
  const language = safeStr(attrs.la);
  const codes = (content[F_CHILDREN] as JsonNode[] | undefined) ?? [];
  let codeBlock = '';
  for (const code of codes) {
    codeBlock += getCommonText(code) + '\n';
  }
  return `\`\`\`${language}\n${codeBlock}\`\`\``;
}

function convertHighlight(content: JsonNode): string {
  const lines = (content[F_CHILDREN] as JsonNode[] | undefined) ?? [];
  let block = '';
  for (const line of lines) {
    block += getCommonText(line) + '\n';
  }
  return `\`\`\`\n${block}\`\`\``;
}

function convertQuote(content: JsonNode): string {
  const qList = (content[F_CHILDREN] as JsonNode[] | undefined) ?? [];
  let text = '';
  for (const q of qList) {
    const qt = convertText(q).replace(/\n/g, '');
    text += `> ${qt}\n`;
  }
  return text;
}

function convertList(content: JsonNode): string {
  const text = convertText(content);
  const attrs = (content[F_ATTRS] as JsonNode | undefined) ?? {};
  const isOrdered = safeStr(attrs.lt) || 'unordered';
  if (isOrdered === 'ordered') return `1. ${text}`;
  const levelVal = attrs.ll;
  const level = Math.max(1, Number(levelVal) || 1);
  return '  '.repeat(level - 1) + `- ${text}`;
}

function getTableCellText(cell: JsonNode): string {
  try {
    const children = (cell[F_CHILDREN] as JsonNode[] | undefined) ?? [{}];
    const inner = children[0];
    if (!inner) return ' ';
    const innerChildren = (inner[F_CHILDREN] as JsonNode[] | undefined) ?? [{}];
    const inner2 = innerChildren[0];
    if (!inner2) return ' ';
    const spans = inner2[F_SPANS] as JsonNode[] | undefined;
    if (!spans?.length) return ' ';
    const firstSpan = spans[0];
    if (!firstSpan) return ' ';
    const raw = firstSpan[F_TEXT];
    return typeof raw === 'string' ? raw : ' ';
  } catch {
    return ' ';
  }
}

function convertTable(content: JsonNode): string {
  const trList = (content[F_CHILDREN] as JsonNode[] | undefined) ?? [];
  if (!trList.length) return '';
  let tableLines = '';

  for (let index = 0; index < trList.length; index++) {
    const tc = trList[index];
    if (!tc) continue;
    const cells = (tc[F_CHILDREN] as JsonNode[] | undefined) ?? [];
    const cellCount = cells.length;
    let tableLine = index === 1 ? '| -- '.repeat(cellCount) + '|\n| ' : '| ';

    for (const cell of cells) {
      tableLine += getTableCellText(cell) + ' | ';
    }
    tableLines += tableLine.trimEnd() + '\n';
  }
  return tableLines;
}

function convertDiagram(content: JsonNode): string {
  const codes = (content[F_CHILDREN] as JsonNode[] | undefined) ?? [];
  let codeBlock = '';
  for (const code of codes) {
    codeBlock += getCommonText(code) + '\n';
  }

  if (isMermaidConvertedPlantUml(codeBlock)) {
    const mermaidCode = plantumlToMermaid(codeBlock.trim());
    return `\`\`\`mermaid\n${mermaidCode}\n\`\`\``;
  }

  const attrs = (content[F_ATTRS] as JsonNode | undefined) ?? {};
  const rawLang = safeStr(attrs.la);
  const lang = rawLang.toLowerCase() === 'mermaid' ? 'mermaid' : 'plantuml';
  return `\`\`\`${lang}\n${codeBlock}\`\`\``;
}

const TYPE_CONVERTERS: Record<string, (content: JsonNode) => string> = {
  h: convertHeading,
  im: convertImage,
  a: convertAttach,
  cd: convertCode,
  la: convertHighlight,
  q: convertQuote,
  l: convertList,
  t: convertTable,
  diagram: convertDiagram,
};

/**
 * Convert Youdao JSON note bytes to Markdown.
 */
export function jsonBytesToMarkdown(data: Buffer | Uint8Array): string {
  const jsonData = parseNoteJson(data);
  if (!jsonData) return '';

  const contents = jsonData[F_CHILDREN] as JsonNode[] | undefined;
  if (!contents) return '';
  return joinParts(convertContents(contents));
}

function convertContents(contents: JsonNode[]): { text: string; type: string | undefined }[] {
  const parts: { text: string; type: string | undefined }[] = [];
  for (const content of contents) {
    const ctype = content[F_TYPE] as string | undefined;
    let lineContent: string;
    if (ctype && TYPE_CONVERTERS[ctype]) {
      lineContent = TYPE_CONVERTERS[ctype](content);
    } else {
      lineContent = convertText(content);
    }
    if (lineContent) parts.push({ text: lineContent, type: ctype });
  }
  return parts;
}

function joinParts(parts: { text: string; type: string | undefined }[]): string {
  let out = '';
  let prevType: string | undefined;
  for (let idx = 0; idx < parts.length; idx++) {
    const part = parts[idx];
    if (!part) continue;
    if (idx > 0) out += prevType === 'l' && part.type === 'l' ? '\n' : '\n\n';
    out += part.text;
    prevType = part.type;
  }
  return out;
}

function parseNoteJson(data: Buffer | Uint8Array): JsonNode | null {
  try {
    const str = typeof data === 'string' ? data : Buffer.from(data).toString('utf-8');
    return JSON.parse(str) as JsonNode;
  } catch {
    return null;
  }
}
