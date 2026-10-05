import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

const alias = { '@shared': resolve(__dirname, 'src/shared') }

/**
 * Política de conteúdo só no build: o servidor de desenvolvimento precisa de
 * script inline (React Refresh) e WebSocket, então lá ela não entra.
 */
function cspNoBuild(): Plugin {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: tomada-media:",
    "media-src 'self' blob: tomada-media:",
    "font-src 'self' data:",
    "connect-src 'self' tomada-media:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'"
  ].join('; ')
  return {
    name: 'tomada-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<!--csp-->', `<meta http-equiv="Content-Security-Policy" content="${csp}" />`)
    }
  }
}

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias },
    plugins: [react(), tailwindcss(), cspNoBuild()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    }
  }
})
