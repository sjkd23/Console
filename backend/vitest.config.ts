import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: true,
    // Run tests sequentially to avoid database conflicts
    // Both test files use the same test database and shared IDs
    fileParallelism: false,
  },
});
