import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // dist can contain stale compiled tests from older checkouts; source tests are canonical.
        include: ['src/**/*.test.ts'],
    },
});
