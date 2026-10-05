/**
 * Forma de onda da voz na trilha de vídeo. Desenha SÓ a parte visível (um canvas do tamanho da área
 * rolável, deslocado pela rolagem), a partir dos picos já calculados pelo ffmpeg: uma coluna de pixel
 * junta os picos que caem nela. Com os cortes escondidos, cada trecho mantido é desenhado em seguida.
 */
import { useEffect, useRef } from 'react'
import { peaksForPixels } from '@shared/peaks'
import type { PeaksData } from '@shared/ipc'
import type { TimelineView } from './view'

export function Waveform({ peaks, voiceOffsetMs, view }: { peaks: PeaksData; voiceOffsetMs: number; view: TimelineView }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ctx = el.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const W = Math.max(1, Math.round(view.viewportW * dpr))
    const H = Math.max(1, Math.round(el.clientHeight * dpr))
    if (el.width !== W) el.width = W
    if (el.height !== H) el.height = H
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = getComputedStyle(el).getPropertyValue('--wave-color').trim() || 'rgba(236,232,225,0.75)'

    const { map, ppm, scrollLeft } = view
    const spans = view.spans()
    const mid = H / 2
    for (const sp of spans) {
      const x0 = Math.max(0, sp.displayStart * ppm - scrollLeft)
      const x1 = Math.min(view.viewportW, (sp.displayStart + (sp.sourceEnd - sp.sourceStart)) * ppm - scrollLeft)
      if (x1 <= x0) continue
      const px0 = Math.floor(x0 * dpr)
      const px1 = Math.ceil(x1 * dpr)
      // instante de ORIGEM na primeira coluna deste trecho → instante do ARQUIVO de voz
      const sourceAt = sp.sourceStart + ((px0 / dpr + scrollLeft) / ppm - sp.displayStart)
      const cols = peaksForPixels(peaks, sourceAt - voiceOffsetMs, 1 / (ppm * dpr), px1 - px0)
      for (let i = 0; i < cols.length; i++) {
        const v = cols[i]!
        if (v <= 0) continue
        // curva suave: a fala média fica visível sem o pico empurrar tudo para baixo
        const h = Math.max(0.6 * dpr, Math.pow(v, 0.72) * mid * 0.8)
        ctx.fillRect(px0 + i, mid - h, 1, h * 2)
      }
    }
    void map
  }, [peaks, voiceOffsetMs, view])

  return <canvas ref={ref} className="tl-wave" style={{ left: view.scrollLeft, width: view.viewportW }} aria-hidden="true" data-testid="waveform" />
}
