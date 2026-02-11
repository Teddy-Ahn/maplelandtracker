import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite 설정: 빌드 도구가 어떻게 동작할지 정의합니다.
// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // GitHub Pages: https://<username>.github.io/maplelandtracker/
  base: process.env.NODE_ENV === 'production' ? '/maplelandtracker/' : '/',
})
