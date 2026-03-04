import { describe, expect, it } from 'vitest';
import { createCli } from './cli.js';

describe('createCli', () => {
  it('creates CLI with expected commands', () => {
    const program = createCli();
    const names = program.commands.map((c) => c.name());
    expect(names).toContain('sync');
    expect(names).toContain('watch');
    expect(names).toContain('login');
  });

  it('sync command has --dry-run option', () => {
    const program = createCli();
    const sync = program.commands.find((c) => c.name() === 'sync');
    const opts = sync?.options.map((o) => o.long);
    expect(opts).toContain('--dry-run');
  });

  it('sync command has --git option', () => {
    const program = createCli();
    const sync = program.commands.find((c) => c.name() === 'sync');
    const opts = sync?.options.map((o) => o.long);
    expect(opts).toContain('--git');
  });

  it('sync command has --dir option', () => {
    const program = createCli();
    const sync = program.commands.find((c) => c.name() === 'sync');
    const opts = sync?.options.map((o) => o.long);
    expect(opts).toContain('--dir');
  });

  it('sync command has --push option', () => {
    const program = createCli();
    const sync = program.commands.find((c) => c.name() === 'sync');
    const opts = sync?.options.map((o) => o.long);
    expect(opts).toContain('--push');
  });

  it('sync command has --pull option', () => {
    const program = createCli();
    const sync = program.commands.find((c) => c.name() === 'sync');
    const opts = sync?.options.map((o) => o.long);
    expect(opts).toContain('--pull');
  });

  it('sync command has --no-dedup option', () => {
    const program = createCli();
    const sync = program.commands.find((c) => c.name() === 'sync');
    const opts = sync?.options.map((o) => o.long);
    expect(opts).toContain('--no-dedup');
  });

  it('watch command has --interval option', () => {
    const program = createCli();
    const watch = program.commands.find((c) => c.name() === 'watch');
    const opts = watch?.options.map((o) => o.long);
    expect(opts).toContain('--interval');
  });
});
