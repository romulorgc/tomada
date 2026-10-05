import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'
import { buildCsp } from './src/shared/csp'

const alias = { '@shared': resolve(__dirname, 'src/shared') }

/**
 * Política de conteúdo só no build: o servidor de desenvolvimento precisa de
 * script inline (React Refresh) e WebSocket, então lá ela não entra. O texto vem de
 * `src/shared/csp.ts` (testado: sem `http:`, `https:` nem `*`). No desenvolvimento, quem barra a rede é
 * o processo principal (`webRequest`, em `src/main/index.ts`).
 */
function cspNoBuild(): Plugin {
  const csp = buildCsp()
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
        // O rastreador do cursor roda num worker_thread: precisa do próprio arquivo compilado.
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'tracker-worker': resolve(__dirname, 'src/main/tracker-worker.ts')
        }
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
