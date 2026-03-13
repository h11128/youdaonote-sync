import { describe, expect, it } from 'vitest';
import { getGuiHtml } from './ui.js';

describe('getGuiHtml', () => {
  it('returns string starting with <!DOCTYPE html>', () => {
    const html = getGuiHtml();
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
  });

  it('contains id="app"', () => {
    expect(getGuiHtml()).toContain('id="app"');
  });

  it('contains id="fileBody"', () => {
    expect(getGuiHtml()).toContain('id="fileBody"');
  });

  it('contains id="searchInput"', () => {
    expect(getGuiHtml()).toContain('id="searchInput"');
  });

  it('contains API endpoints', () => {
    const html = getGuiHtml();
    expect(html).toContain('/api/root');
    expect(html).toContain('/api/dir');
    expect(html).toContain('/api/download');
    expect(html).toContain('/api/search');
  });

  it('contains title Youdao Note Manager', () => {
    expect(getGuiHtml()).toContain('<title>Youdao Note Manager</title>');
  });

  it('contains essential functions', () => {
    const html = getGuiHtml();
    expect(html).toContain('loadRoot');
    expect(html).toContain('loadDir');
    expect(html).toContain('enterDir');
    expect(html).toContain('search');
    expect(html).toContain('goBack');
  });

  it('ends with </html>', () => {
    const html = getGuiHtml();
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });
});
