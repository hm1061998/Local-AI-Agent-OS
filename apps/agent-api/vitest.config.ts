import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export default defineConfig({
  test: { environment: 'node', include: ['apps/agent-api/test/**/*.test.ts'] },
  resolve: {
    alias: {
      '@local-agent/agent-protocol': resolve('packages/agent-protocol/src/index.ts'),
      '@local-agent/event-schema': resolve('packages/event-schema/src/index.ts'),
      '@local-agent/model-provider': resolve('packages/model-provider/src/index.ts'),
      '@local-agent/skill-schema': resolve('packages/skill-schema/src/index.ts'),
      '@local-agent/shared-types': resolve('packages/shared-types/src/index.ts'),
      '@local-agent/test-utils': resolve('packages/test-utils/src/index.ts'),
    },
  },
});
