/**
 * Avisa o processo principal enquanto a prévia do editor TOCA (R1): o recorte do fundo roda em segundo plano na mesma placa de vídeo e dá
 * lugar à prévia (para no fim do pedaço em curso e volta depois que ela fica parada alguns segundos). O aviso é repetido enquanto toca; se
 * o editor sumir sem avisar que parou, o processo principal esquece sozinho (TTL).
 */
import { useEffect } from 'react'
import type { PlaybackStore } from './playback-store'

/** De quanto em quanto tempo o aviso "estou tocando" é repetido (ms); precisa ser bem menor que o prazo de validade dele no processo principal. */
export const PREVIEW_HEARTBEAT_MS = 5000

export function usePreviewHeartbeat(playback: PlaybackStore): void {
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    const send = (active: boolean): void => {
      const camera = (window as { tomada?: { camera?: { previewActive?: (active: boolean) => Promise<void> } } }).tomada?.camera
      void camera?.previewActive?.(active).catch(() => undefined)
    }
    let last = false
    const sync = (playing: boolean): void => {
      last = playing
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
      send(playing)
      if (playing) timer = setInterval(() => send(true), PREVIEW_HEARTBEAT_MS)
    }
    if (playback.getState().playing) sync(true)
    const off = playback.subscribe((s) => {
      if (s.playing !== last) sync(s.playing)
    })
    return () => {
      off()
      if (timer) clearInterval(timer)
      if (last) send(false)
    }
  }, [playback])
}
