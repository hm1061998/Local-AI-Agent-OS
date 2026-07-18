import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node', include: ['apps/sandbox-runner/test/**/*.test.ts'] },
});
