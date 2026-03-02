import { describe, expect, it } from 'vitest';
import { tpl, DIR_PAGE_SIZE, ROOT_ID_URL } from './constants.js';

describe('constants', () => {
  describe('tpl', () => {
    it('replaces single placeholder', () => {
      expect(tpl('hello {name}', { name: 'world' })).toBe('hello world');
    });
    it('replaces multiple placeholders', () => {
      expect(tpl('{a}_{b}', { a: 'x', b: 'y' })).toBe('x_y');
    });
    it('replaces same placeholder multiple times', () => {
      expect(tpl('{cstk}&x={cstk}', { cstk: 'abc' })).toBe('abc&x=abc');
    });
    it('leaves url unchanged when vars empty', () => {
      expect(tpl(ROOT_ID_URL, {})).toBe(ROOT_ID_URL);
    });
    it('substitutes cstk in ROOT_ID_URL', () => {
      const out = tpl(ROOT_ID_URL, { cstk: 'xyz' });
      expect(out).toContain('cstk=xyz');
      expect(out).not.toContain('{cstk}');
    });
  });

  it('DIR_PAGE_SIZE is 9999', () => {
    expect(DIR_PAGE_SIZE).toBe(9999);
  });
});
