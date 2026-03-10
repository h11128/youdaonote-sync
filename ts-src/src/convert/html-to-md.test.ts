import { describe, expect, it } from 'vitest';
import { htmlStringToMarkdown, htmlBytesToMarkdown } from './html-to-md.js';

describe('htmlStringToMarkdown: inline elements', () => {
  it('converts headings h1-h6', () => {
    expect(htmlStringToMarkdown('<h1>One</h1>')).toContain('# One');
    expect(htmlStringToMarkdown('<h2>Two</h2>')).toContain('## Two');
    expect(htmlStringToMarkdown('<h3>Three</h3>')).toContain('### Three');
    expect(htmlStringToMarkdown('<h6>Six</h6>')).toContain('###### Six');
  });

  it('converts bold and italic', () => {
    expect(htmlStringToMarkdown('<strong>bold</strong>')).toBe('**bold**');
    expect(htmlStringToMarkdown('<b>bold</b>')).toBe('**bold**');
    expect(htmlStringToMarkdown('<em>italic</em>')).toBe('*italic*');
    expect(htmlStringToMarkdown('<i>italic</i>')).toBe('*italic*');
  });

  it('converts strikethrough', () => {
    expect(htmlStringToMarkdown('<del>deleted</del>')).toBe('~~deleted~~');
    expect(htmlStringToMarkdown('<s>struck</s>')).toBe('~~struck~~');
  });

  it('converts inline code', () => {
    expect(htmlStringToMarkdown('<code>x = 1</code>')).toBe('`x = 1`');
  });

  it('converts code blocks', () => {
    const result = htmlStringToMarkdown('<pre><code>function foo() {}</code></pre>');
    expect(result).toContain('```');
    expect(result).toContain('function foo() {}');
  });

  it('converts links', () => {
    expect(htmlStringToMarkdown('<a href="https://example.com">Click</a>')).toBe(
      '[Click](https://example.com)',
    );
  });

  it('converts images with alt text', () => {
    expect(htmlStringToMarkdown('<img src="pic.png" alt="Photo" />')).toBe('![Photo](pic.png)');
  });

  it('converts images without alt text', () => {
    expect(htmlStringToMarkdown('<img src="pic.png" />')).toBe('![](pic.png)');
  });

  it('converts images with single-quote src', () => {
    expect(htmlStringToMarkdown("<img src='pic.png' alt='Photo' />")).toBe('![Photo](pic.png)');
    expect(htmlStringToMarkdown("<img src='pic.png' />")).toBe('![](pic.png)');
  });

  it('converts links with single-quote href', () => {
    expect(htmlStringToMarkdown("<a href='https://example.com'>Click</a>")).toBe(
      '[Click](https://example.com)',
    );
  });
});

describe('htmlStringToMarkdown: block elements', () => {
  it('converts list items', () => {
    const result = htmlStringToMarkdown('<ul><li>A</li><li>B</li></ul>');
    expect(result).toContain('- A');
    expect(result).toContain('- B');
  });

  it('converts blockquote', () => {
    expect(htmlStringToMarkdown('<blockquote>quoted text</blockquote>')).toContain('> quoted text');
  });

  it('converts horizontal rule', () => {
    expect(htmlStringToMarkdown('<hr/>')).toContain('---');
  });

  it('converts line breaks', () => {
    expect(htmlStringToMarkdown('line1<br/>line2')).toContain('line1\nline2');
  });

  it('converts paragraphs', () => {
    const result = htmlStringToMarkdown('<p>First</p><p>Second</p>');
    expect(result).toContain('First');
    expect(result).toContain('Second');
  });

  it('converts basic table', () => {
    const html = '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>';
    const result = htmlStringToMarkdown(html);
    expect(result).toContain('| A | B |');
    expect(result).toContain('| --- | --- |');
    expect(result).toContain('| 1 | 2 |');
  });

  it('strips script and style tags', () => {
    const html = '<script>alert("xss")</script><style>.x{}</style><p>safe</p>';
    const result = htmlStringToMarkdown(html);
    expect(result).not.toContain('alert');
    expect(result).toContain('safe');
  });

  it('decodes HTML entities', () => {
    const result = htmlStringToMarkdown('&amp; &lt; &gt; &quot; &#39; &nbsp;');
    expect(result).toContain('& < > "');
    expect(result).toContain("'");
  });

  it('decodes numeric HTML entities', () => {
    expect(htmlStringToMarkdown('&#123;&#125;')).toBe('{}');
    expect(htmlStringToMarkdown('&#x7B;&#x7D;')).toBe('{}');
    expect(htmlStringToMarkdown('&#x4F60;&#x597D;')).toBe('你好');
  });

  it('strips unknown HTML tags', () => {
    expect(htmlStringToMarkdown('<span class="x">text</span>')).toBe('text');
  });

  it('collapses excessive newlines', () => {
    expect(htmlStringToMarkdown('<p>A</p><p></p><p></p><p>B</p>')).not.toContain('\n\n\n');
  });

  it('handles empty input', () => {
    expect(htmlStringToMarkdown('')).toBe('');
  });
});

describe('htmlBytesToMarkdown', () => {
  it('converts Uint8Array HTML to markdown', () => {
    const data = new TextEncoder().encode('<h1>Title</h1><p>Body</p>');
    const result = htmlBytesToMarkdown(data);
    expect(result).toContain('# Title');
    expect(result).toContain('Body');
  });
});
