import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@typo/plugin-api/testing': fileURLToPath(
        new URL('./packages/plugin-api/src/testing/index.ts', import.meta.url),
      ),
      '@typo/plugin-api': pkg('plugin-api'),
      '@typo/markdown/text': fileURLToPath(
        new URL('./packages/markdown/src/text.ts', import.meta.url),
      ),
      '@typo/markdown': pkg('markdown'),
      '@typo/export': pkg('export'),
      '@typo/editor': pkg('editor'),
    },
  },
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/*.d.ts'],
    },
  },
})
