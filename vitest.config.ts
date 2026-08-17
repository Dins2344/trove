import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Only src/core is tested here: it is deliberately free of Electron
    // imports, so it runs under plain Node with no harness.
    include: ['src/core/**/*.test.ts'],
    environment: 'node'
  }
})
