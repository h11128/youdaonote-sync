import { beforeAll } from 'vitest';
import { initXxhash } from './algo/xxhash.js';

beforeAll(async () => {
  await initXxhash();
});
