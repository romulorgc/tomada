import { describe, expect, it } from 'vitest'
import { createMicVolumeService } from '../../src/main/mic-volume'

/** Só LEITURA do volume real: o teste nunca muda o volume de entrada de ninguém. */
describe.runIf(process.platform === 'win32')('volume de entrada real do Windows (WASAPI, só leitura)', () => {
  it('lê o microfone padrão com faixa e nome plausíveis', async () => {
    const svc = createMicVolumeService({ cacheDir: 'C:/tmp/tomada-mic-cache-teste' })
    const info = await svc.read('Padrão - Microfone')
    // Máquina sem microfone ativo: nada a conferir (o serviço devolve null, nunca lança).
    if (!info) return
    expect(info.name.length).toBeGreaterThan(0)
    expect(info.scalar).toBeGreaterThanOrEqual(0)
    expect(info.scalar).toBeLessThanOrEqual(1)
    expect(info.maxDb).toBeGreaterThanOrEqual(info.minDb)
    expect(info.db).toBeGreaterThanOrEqual(info.minDb - 0.01)
    expect(info.db).toBeLessThanOrEqual(info.maxDb + 0.01)
    expect(info.isDefault).toBe(true)
  }, 60_000)
})
