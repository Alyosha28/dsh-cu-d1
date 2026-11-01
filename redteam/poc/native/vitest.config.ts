import { defineConfig } from 'vitest/config'

// Red-team PoC runner. Deliberately separate from the package's own config so
// these files never join the product test suite.
export default defineConfig({
  test: {
    include: ['*.spec.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    sequence: { concurrent: false },
    reporters: ['verbose'],
  },
})
