import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { DATA_FILES } from './src/core/data/manifest.ts'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), {
      name: 'bundled-item-metadata',
      generateBundle() {
        // Driven by the manifest, not a hand-kept list: a file the code requires
        // but nobody remembered to emit is how packaged builds broke before.
        for (const file of DATA_FILES) {
          this.emitFile({
            type: 'asset',
            fileName: file,
            source: readFileSync(resolve(__dirname, 'src/core/data', file), 'utf8')
          })
        }
      }
    }],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } } }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: { '@core': resolve(__dirname, 'src/core') } },
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } } },
    plugins: [react()]
  }
})
