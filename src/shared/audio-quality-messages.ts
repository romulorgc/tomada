/** Dicionário pt-BR compartilhado pela interface e pelas notas persistidas do processamento. */
import type { AudioQualityReport } from './audio-quality'

const value = (n: number): string => n.toFixed(1).replace('.', ',')
export const audioQualityPtBR = {
  title: 'Confira o áudio desta gravação',
  pcmSyncWarning: 'Não foi possível confirmar a sincronia da voz. Confira se a voz acompanha a imagem no editor.',
  clipping: (ms: number): string => `O microfone chegou perto de estourar por ${Math.round(ms)} ms acumulados (picos a partir de -0,5 dBFS). Reduza o ganho ou afaste-se do microfone na próxima gravação. O tratamento não recupera trechos que já estouraram.`,
  lowVoice: (rms: number): string => `A voz ficou baixa nos trechos ativos: ${value(rms)} dBFS RMS (abaixo de -35 dBFS). Aproxime-se ou aumente o ganho do microfone na próxima gravação e ouça o resultado antes de publicar.`
}

export function audioQualityWarningMessages(report?: AudioQualityReport, pcmSyncWarning = false): string[] {
  const messages = report?.warnings.flatMap((warning) => warning === 'clipping'
    ? [audioQualityPtBR.clipping(report.clippingMs)]
    : report.activeRmsDbfs === null ? [] : [audioQualityPtBR.lowVoice(report.activeRmsDbfs)]) ?? []
  if (pcmSyncWarning) messages.push(audioQualityPtBR.pcmSyncWarning)
  return messages
}
