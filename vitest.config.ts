import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@mosu/plugin-api/testing': fileURLToPath(
        new URL('./packages/plugin-api/src/testing/index.ts', import.meta.url),
      ),
      '@mosu/plugin-api': pkg('plugin-api'),
      '@mosu/markdown/text': fileURLToPath(
        new URL('./packages/markdown/src/text.ts', import.meta.url),
      ),
      '@mosu/markdown': pkg('markdown'),
      '@mosu/agent-core': pkg('agent-core'),
      '@mosu/export': pkg('export'),
      '@mosu/import': pkg('import'),
      '@mosu/editor': pkg('editor'),
    },
  },
  test: {
    include: [
      'packages/**/test/**/*.test.ts',
      'apps/**/test/**/*.test.ts',
      'test/**/*.test.ts',
    ],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/*.d.ts'],
    },
  },
})
