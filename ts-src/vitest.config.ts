import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test-setup.ts'],
    coverage: {
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/cli.ts',
        'src/cli-browse.ts',
        'src/smoke-test.ts',
        'src/**/index.ts',
      ],
    },
  },
});
