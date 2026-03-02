const F_ATTRS = '4';
const F_CHILDREN = '5';
const F_TYPE = '6';
const F_SPANS = '7';
const F_TEXT = '8';
const F_TEXT_ATTRS = '9';
const F_ATTR_TYPE = '2';

type JsonNode = Record<string, unknown>;

function getCommonText(content: JsonNode): string {
  let allText = '';
  const children = content[F_CHILDREN] as JsonNode[] | undefined;
  if (!children?.length) return allText;

  const spans = children[0]![F_SPANS] as JsonNode[] | undefined;
  if (!spans) return allText;

  for (const span of spans) {
    let text = (span[F_TEXT] as string) ?? '';
    const textAttrs = span[F_TEXT_ATTRS] as JsonNode[] | undefined;
    if (text && textAttrs) {
      text = convertTextAttribute(text, textAttrs);
    }
    allText += text;
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

function convertText(content: JsonNode): string {
  let allText = '';
  const oneChildren = content[F_CHILDREN] as JsonNode[] | undefined;
  if (!oneChildren) return allText;

  for (const child of oneChildren) {
    const twoChildren = child[F_CHILDREN] as JsonNode[] | undefined;
    const textType = child[F_TYPE] as string | undefined;
    const spans = child[F_SPANS] as JsonNode[] | undefined;
    let text = '';

    if (spans && !twoChildren) {
      for (const span of spans) {
        let raw = (span[F_TEXT] as string) ?? '';
        const textAttrs = span[F_TEXT_ATTRS] as JsonNode[] | undefined;
        if (raw && textAttrs) raw = convertTextAttribute(raw, textAttrs);
        text += raw;
      }
    } else if (textType === 'li' && twoChildren) {
      const sourceText = getCommonText(child);
      const attrs = child[F_ATTRS] as JsonNode | undefined;
      if (attrs) {
        const hf = attrs['hf'] as string;
        text = `[${sourceText}](${hf})`;
      }
    }

    if (text) allText += text;
  }
  return allText;
}

function convertHeading(content: JsonNode): string {
  const attrs = (content[F_ATTRS] as JsonNode) ?? {};
  const typeName = attrs['l'] as string | undefined;
  let text = getCommonText(content);
  if (text && typeName) {
    const levelStr = typeName.replace('h', '');
    const level = parseInt(levelStr, 10) || 1;
    text = `${'#'.repeat(level)} ${text}`;
  }
  return text;
}

function convertImage(content: JsonNode): string {
  const attrs = (content[F_ATTRS] as JsonNode) ?? {};
  return `![](${attrs['u'] ?? ''})`;
}

function convertAttach(content: JsonNode): string {
  const attrs = (content[F_ATTRS] as JsonNode) ?? {};
  return `[${attrs['fn'] ?? ''}](${attrs['re'] ?? ''})`;
}

function convertCode(content: JsonNode): string {
  const attrs = (content[F_ATTRS] as JsonNode) ?? {};
  const language = (attrs['la'] as string) ?? '';
  const codes = (content[F_CHILDREN] as JsonNode[]) ?? [];
  let codeBlock = '';
  for (const code of codes) {
    codeBlock += getCommonText(code) + '\n';
  }
  return `\`\`\`${language}\n${codeBlock}\`\`\``;
}

function convertHighlight(content: JsonNode): string {
  const lines = (content[F_CHILDREN] as JsonNode[]) ?? [];
  let block = '';
  for (const line of lines) {
    block += getCommonText(line) + '\n';
  }
  return `\`\`\`\n${block}\`\`\``;
}

function convertQuote(content: JsonNode): string {
  const qList = (content[F_CHILDREN] as JsonNode[]) ?? [];
  let text = '';
  for (const q of qList) {
    const qt = getCommonText(q).replace(/\n/g, '');
    text += `> ${qt}\n`;
  }
  return text;
}

function convertList(content: JsonNode): string {
  const text = getCommonText(content);
  const attrs = (content[F_ATTRS] as JsonNode) ?? {};
  const isOrdered = (attrs['lt'] as string) ?? 'unordered';
  if (isOrdered === 'ordered') return `1. ${text}`;
  const level = Number(attrs['ll'] ?? 1) || 1;
  return '\t'.repeat(level - 1) + `- ${text}`;
}

function convertTable(content: JsonNode): string {
  const trList = (content[F_CHILDREN] as JsonNode[]) ?? [];
  if (!trList.length) return '';
  let tableLines = '';

  for (let index = 0; index < trList.length; index++) {
    const tc = trList[index]!;
    const cells = (tc[F_CHILDREN] as JsonNode[]) ?? [];
    const cellCount = cells.length;
    let tableLine = index === 1
      ? '| -- '.repeat(cellCount) + '|\n| '
      : '| ';

    for (const cell of cells) {
      let tableText = ' ';
      try {
        const inner = ((cell[F_CHILDREN] as JsonNode[]) ?? [{}])[0]!;
        const inner2 = ((inner[F_CHILDREN] as JsonNode[]) ?? [{}])[0]!;
        const spans = inner2[F_SPANS] as JsonNode[] | undefined;
        if (spans?.length) tableText = (spans[0]![F_TEXT] as string) ?? ' ';
      } catch { /* fallback to space */ }
      tableLine += tableText + ' | ';
    }
    tableLines += tableLine + '\n';
  }
  return tableLines;
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
};

/**
 * Convert Youdao JSON note bytes to Markdown.
 */
export function jsonBytesToMarkdown(data: Buffer | Uint8Array): string {
  let jsonData: JsonNode;
  try {
    const str = typeof data === 'string' ? data : Buffer.from(data).toString('utf-8');
    jsonData = JSON.parse(str) as JsonNode;
  } catch {
    return '';
  }

  const contents = jsonData[F_CHILDREN] as JsonNode[] | undefined;
  if (!contents) return '';

  const result: string[] = [];
  for (const content of contents) {
    const ctype = content[F_TYPE] as string | undefined;
    let lineContent: string;
    if (ctype && TYPE_CONVERTERS[ctype]) {
      lineContent = TYPE_CONVERTERS[ctype]!(content);
    } else {
      lineContent = convertText(content);
    }
    if (lineContent) result.push(lineContent);
  }
  return result.join('\n\n');
}
