import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tasks/tests/**/*.test.ts', 'packages/*/tests/**/*.test.ts'],
  },
});
