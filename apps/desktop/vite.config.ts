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
      '@mosu/plugin-api': pkg('plugin-api'),
      '@mosu/markdown': pkg('markdown'),
      '@mosu/editor': pkg('editor'),
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
