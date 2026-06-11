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
    // WSL 下 /mnt/* 无 inotify 事件,轮询保证 HMR/模块缓存失效正常
    watch: { usePolling: true, interval: 800 },
  },
  build: {
    target: 'es2021',
    chunkSizeWarningLimit: 1200,
  },
})
