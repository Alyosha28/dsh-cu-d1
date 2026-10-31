import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    exclude: ['tests/**/*.e2e.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
