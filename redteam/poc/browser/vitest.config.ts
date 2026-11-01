import { defineConfig } from 'vitest/config'

/**
 * Red-team PoC suite. Run from the repository root:
 *   npx vitest run --config redteam/poc/browser/vitest.config.ts
 */
export default defineConfig({
  test: {
    include: ['redteam/poc/browser/**/*.spec.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
})
