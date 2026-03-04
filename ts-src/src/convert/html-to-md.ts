/**
 * Minimal HTML → Markdown converter for Youdao note content.
 * Handles the most common HTML elements found in Youdao notes.
 */
export function htmlBytesToMarkdown(data: Uint8Array): string {
  const html = Buffer.from(data).toString('utf-8');
  return htmlStringToMarkdown(html);
}

function convertInlineElements(md: string): string {
  let result = md;
  result = result.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  result = result.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
  result = result.replace(/<(del|s|strike)[^>]*>([\s\S]*?)<\/\1>/gi, '~~$2~~');
  result = result.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n');
  result = result.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');
  result = result.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  result = result.replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, '![$2]($1)');
  result = result.replace(/<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*\/?>/gi, '![$1]($2)');
  result = result.replace(/<img[^>]*src="([^"]*)"[^>]*\/?>/gi, '![]($1)');
  result = result.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  return result;
}

function convertBlockElements(md: string): string {
  let result = md;
  result = result.replace(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_, level: string, text: string) => `\n${'#'.repeat(Number(level))} ${text}\n`,
  );
  result = result.replace(/<ul[^>]*>/gi, '\n');
  result = result.replace(/<\/ul>/gi, '\n');
  result = result.replace(/<ol[^>]*>/gi, '\n');
  result = result.replace(/<\/ol>/gi, '\n');
  result = result.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  result = result.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, c: string) =>
    c
      .split('\n')
      .map((l: string) => `> ${l}`)
      .join('\n'),
  );
  result = result.replace(/<hr[^>]*\/?>/gi, '\n---\n');
  result = result.replace(/<br\s*\/?>/gi, '\n');
  result = result.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n');
  result = result.replace(/<div[^>]*>([\s\S]*?)<\/div>/gi, '\n$1\n');
  return result;
}

function convertTable(md: string): string {
  return md.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, tableContent: string) => {
    const rows: string[] = [];
    const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let trMatch: RegExpExecArray | null;
    while ((trMatch = trRegex.exec(tableContent)) !== null) {
      const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      const cells: string[] = [];
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellRegex.exec(trMatch[1] ?? '')) !== null) {
        cells.push((cellMatch[1] ?? '').trim());
      }
      rows.push('| ' + cells.join(' | ') + ' |');
    }
    if (rows.length > 1) {
      const first = rows[0] ?? '';
      const sep =
        '| ' +
        first
          .split('|')
          .slice(1, -1)
          .map(() => '---')
          .join(' | ') +
        ' |';
      rows.splice(1, 0, sep);
    }
    return '\n' + rows.join('\n') + '\n';
  });
}

function decodeEntities(md: string): string {
  return md
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

export function htmlStringToMarkdown(html: string): string {
  let md = html;
  md = md.replace(/<script[\s\S]*?<\/script>/gi, '');
  md = md.replace(/<style[\s\S]*?<\/style>/gi, '');
  md = convertInlineElements(md);
  md = convertBlockElements(md);
  md = convertTable(md);
  md = md.replace(/<[^>]+>/g, '');
  md = decodeEntities(md);
  md = md.replace(/\n{3,}/g, '\n\n');
  return md.trim();
}
