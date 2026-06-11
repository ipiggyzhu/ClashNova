import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Tauri 前端构建配置：固定端口、保留 Rust 侧日志输出
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'es2021',
    chunkSizeWarningLimit: 1200,
  },
})
