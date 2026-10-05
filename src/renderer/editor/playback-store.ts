/**
 * Estado de REPRODUÇÃO da prévia (separado do documento): o motor escreve a cada quadro e só os componentes
 * que mostram o tempo (cabeça de reprodução, relógio, botão de tocar) assinam. Zustand "vanilla".
 */
import { createStore, type StoreApi } from 'zustand/vanilla'

export type PlaybackState = {
  /** Instante de ORIGEM do relógio (ms). */
  sourceMs: number
  /** Instante de SAÍDA correspondente (ms). */
  outMs: number
  playing: boolean
  /** Velocidade do relógio: 0 parado, 1 normal, 2/4 rápido, negativa = para trás. */
  rate: number
  /** O canvas já mostra o quadro do instante atual (nenhuma busca em andamento). */
  ready: boolean
  /** Falha de mídia (vídeo que não abre, play recusado) com o motivo; null = tudo certo. */
  error: string | null
  /** O áudio não está disponível na prévia (arquivo sumiu ou não abriu); o vídeo toca mudo. */
  audioError: string | null
  /** A voz tratada (media/voice-preview.m4a) já assumiu no lugar da voz crua. */
  audioTreated: boolean
}

export type PlaybackStore = StoreApi<PlaybackState>

export function createPlaybackStore(): PlaybackStore {
  return createStore<PlaybackState>()(() => ({
    sourceMs: 0,
    outMs: 0,
    playing: false,
    rate: 0,
    ready: false,
    error: null,
    audioError: null,
    audioTreated: false
  }))
}
