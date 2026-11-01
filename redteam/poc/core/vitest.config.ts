import { defineConfig } from 'vitest/config'

// Red-team PoC harness. Root is the repository root so the specs can import
// package sources directly (packages/**/src/*.ts) without a build step.
export default defineConfig({
  root: new URL('../../../', import.meta.url).pathname,
  test: {
    include: ['redteam/poc/core/**/*.spec.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
