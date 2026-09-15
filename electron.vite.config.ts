import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { DATA_FILES } from './src/core/data/manifest.ts'
import { loadEnv } from 'vite'

// Environment variables win over .env, so a CI build can supply its own.
const buildEnv = { ...loadEnv('production', __dirname, 'BLIZZARD_'), ...process.env }

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
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } } },
    // The Blizzard API client used for armory lookups, taken from .env when the
    // app is built. It ends up inside the packaged app, never in the repository.
    define: {
      __BLIZZARD_CLIENT_ID__: JSON.stringify(buildEnv['BLIZZARD_CLIENT_ID']?.trim() ?? ''),
      __BLIZZARD_CLIENT_SECRET__: JSON.stringify(buildEnv['BLIZZARD_CLIENT_SECRET']?.trim() ?? '')
    }
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
