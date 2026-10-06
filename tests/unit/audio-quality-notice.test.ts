import { describe, expect, it } from 'vitest'
import { analyzeAudioQuality } from '@shared/audio-quality'
import { audioQualityWarningMessages } from '@shared/audio-quality-messages'
import { createProject, parseProject, serializeProject } from '@shared/project'

describe('aviso de áudio salvo e visível', () => {
  it('sobrevive ao arquivo do projeto e descreve estouro na interface ao reabrir', () => {
    const project = createProject({ title: 'Gravação sintética' })
    project.audioQuality = analyzeAudioQuality(new Float32Array(4800).fill(0.95), 48_000)
    const reopened = parseProject(serializeProject(project))
    expect(reopened.audioQuality?.warnings).toEqual(['clipping'])
    const messages = audioQualityWarningMessages(reopened.audioQuality!)
    expect(messages.join(' ')).toMatch(/estour|ganho/i)
    expect(messages.join(' ')).toContain('100 ms')
  })

  it('explica nível baixo usando RMS dos blocos ativos e não mostra aviso quando não há problema', () => {
    const signal = new Float32Array(48_000)
    for (let i = 0; i < 48_000; i++) signal[i] = 0.01 * Math.SQRT2 * Math.sin(2 * Math.PI * 200 * i / 48_000)
    const report = analyzeAudioQuality(signal, 48_000, { activeRanges: [{ start: 0, end: 1000 }] })
    const messages = audioQualityWarningMessages(report)
    expect(messages.join(' ')).toMatch(/voz.*baixa/i)
    expect(messages.join(' ')).toContain('-40,0 dBFS')
    expect(audioQualityWarningMessages(analyzeAudioQuality(new Float32Array(48_000), 48_000))).toEqual([])
  })

  it('rejeita métricas não finitas ou aviso desconhecido ao ler um projeto', () => {
    const project = createProject({ title: 'Gravação sintética' })
    project.audioQuality = analyzeAudioQuality(new Float32Array(4800).fill(0.95), 48_000)
    expect(() => parseProject(JSON.stringify({ ...project, audioQuality: { ...project.audioQuality, clippingMs: -1 } }))).toThrow()
    expect(() => parseProject(JSON.stringify({ ...project, audioQuality: { ...project.audioQuality, warnings: ['inventado'] } }))).toThrow()
  })

  it('preserva o aviso de sincronia ao reabrir, mesmo sem diagnóstico de nível', () => {
    const project = Object.assign(createProject({ title: 'Gravação sintética' }), { pcmSyncWarning: true })
    project.audioQuality = analyzeAudioQuality(new Float32Array(48_000), 48_000)
    const reopened = parseProject(serializeProject(project))
    expect(reopened.pcmSyncWarning).toBe(true)
    const messages = audioQualityWarningMessages(reopened.audioQuality, reopened.pcmSyncWarning)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatch(/sincronia.*voz|voz.*sincronia/i)
    expect(messages[0]).toMatch(/confira.*imagem/i)
    expect(audioQualityWarningMessages(undefined)).toEqual([])
    expect(audioQualityWarningMessages(undefined, false)).toEqual([])
  })

  it('rejeita um aviso de sincronia que não seja booleano', () => {
    const project = createProject({ title: 'Gravação sintética' })
    expect(() => parseProject(JSON.stringify({ ...project, pcmSyncWarning: 'talvez' }))).toThrow()
  })
})
