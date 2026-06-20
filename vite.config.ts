import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
}

// Tauri 前端构建配置：固定端口、保留 Rust 侧日志输出
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 5173,
    strictPort: true,
    // WSL 下 /mnt/* 无 inotify 事件,轮询保证 HMR/模块缓存失效正常
    watch: { usePolling: true, interval: 800 },
  },
  build: {
    target: 'es2021',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replaceAll('\\', '/')
          if (!normalized.includes('node_modules')) return undefined
          if (
            normalized.includes('/node_modules/react/') ||
            normalized.includes('/node_modules/react-dom/') ||
            normalized.includes('/node_modules/react-router-dom/')
          ) {
            return 'vendor-react'
          }
          if (
            normalized.includes('/node_modules/@codemirror/') ||
            normalized.includes('/node_modules/@uiw/react-codemirror/')
          ) {
            return 'vendor-editor'
          }
          if (normalized.includes('/node_modules/three/')) return 'vendor-three'
          if (
            normalized.includes('/node_modules/globe.gl/') ||
            normalized.includes('/node_modules/d3-') ||
            normalized.includes('/node_modules/topojson') ||
            normalized.includes('/node_modules/world-atlas/')
          ) {
            return 'vendor-map'
          }
          return undefined
        },
      },
    },
  },
})
