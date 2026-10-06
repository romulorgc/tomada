/** Dicionário pt-BR compartilhado pela interface e pelas notas persistidas do processamento. */
import type { AudioQualityReport } from './audio-quality'

const value = (n: number): string => n.toFixed(1).replace('.', ',')
export const audioQualityPtBR = {
  title: 'Confira o áudio desta gravação',
  pcmSyncWarning: 'Não foi possível confirmar a sincronia da voz. Confira se a voz acompanha a imagem no editor.',
  clipping: (ms: number): string => `O microfone chegou perto de estourar por ${Math.round(ms)} ms acumulados (picos a partir de -0,5 dBFS). Reduza o ganho ou afaste-se do microfone na próxima gravação. O tratamento não recupera trechos que já estouraram.`,
  veryLow: (lufs: number, peakDbfs: number | null): string => `A voz bruta ficou em ${value(lufs)} LUFS${peakDbfs === null ? '' : ` com pico em ${value(peakDbfs)} dBFS`} (o normal é perto de -26 LUFS): baixa demais. Para chegar a -14 LUFS a exportação precisa subir tudo uns ${Math.round(-14 - lufs)} dB, e o chiado sobe junto. Quase sempre é o volume de ENTRADA do microfone no Windows (Configurações > Sistema > Som > Entrada), não a sua voz. Na tela Gravar, toque em "Ajustar sozinho" antes da próxima gravação; esta vai soar com chiado.`,
  lowVoice: (rms: number): string => `A voz ficou baixa nos trechos ativos: ${value(rms)} dBFS RMS (abaixo de -35 dBFS). Aproxime-se ou aumente o ganho do microfone na próxima gravação e ouça o resultado antes de publicar.`
}

export function audioQualityWarningMessages(report?: AudioQualityReport, pcmSyncWarning = false): string[] {
  // "Muito baixa" já diz tudo o que "voz baixa" diria: uma mensagem só.
  const messages = report?.warnings.flatMap((warning) => warning === 'clipping'
    ? [audioQualityPtBR.clipping(report.clippingMs)]
    : warning === 'very-low-level'
      ? report.integratedLufs === null || report.integratedLufs === undefined ? [] : [audioQualityPtBR.veryLow(report.integratedLufs, report.peakDbfs)]
      : report.activeRmsDbfs === null || report.warnings.includes('very-low-level') ? [] : [audioQualityPtBR.lowVoice(report.activeRmsDbfs)]) ?? []
  if (pcmSyncWarning) messages.push(audioQualityPtBR.pcmSyncWarning)
  return messages
}
