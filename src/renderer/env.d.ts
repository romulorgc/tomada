/// <reference types="vite/client" />
import type { TomadaApi } from '@shared/ipc'

declare global {
  interface Window {
    /** Ponte tipada exposta pelo preload (única porta para o processo principal). */
    readonly tomada: TomadaApi
  }
}

export {}
