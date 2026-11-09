import { defineConfig } from 'vitest/config';
import { existsSync } from 'node:fs';

if (existsSync('../.env.test')) process.loadEnvFile('../.env.test');

export default defineConfig({
  test: { testTimeout: 20000, hookTimeout: 30000, fileParallelism: false }
});
