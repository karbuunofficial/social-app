import {defineConfig} from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Database tests share one database and must not run concurrently.
    fileParallelism: false,
  },
})
