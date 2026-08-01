import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const pkg = (name: string) =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url))

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Electron 用 file:// 加载打包后的页面，必须走相对路径
  base: './',
  resolve: {
    alias: {
      '@typo/plugin-api': pkg('plugin-api'),
      '@typo/markdown': pkg('markdown'),
      '@typo/editor': pkg('editor'),
    },
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    target: 'chrome128',
    sourcemap: true,
  },
  server: {
    port: 5199,
    strictPort: true,
  },
})
