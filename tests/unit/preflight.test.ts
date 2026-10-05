import { describe, expect, it } from 'vitest'
import { micCheck } from '../../src/shared/preflight'
import { normalizeRecordPrefs } from '../../src/shared/recording'

describe('checagem não bloqueante', () => {
  it('mede RMS e pico sem confundir silêncio com áudio saudável', () => {
    expect(micCheck({ rms: 0.002, peak: 0.005, sampledMs: 2000 }).status).toBe('low')
    expect(micCheck({ rms: 0.12, peak: 0.6, sampledMs: 2000 }).status).toBe('ok')
    expect(micCheck({ rms: 0.12, peak: 0.999, sampledMs: 2000 }).status).toBe('clipping')
    expect(micCheck({ rms: 0.12, peak: 0.6, sampledMs: 500 }).status).toBe('listening')
  })
  it('aceita atalho configurável e recusa atalhos sem modificadores ou conflitos internos', () => {
    expect(normalizeRecordPrefs({ retakeShortcut: 'Ctrl+Alt+X' }).retakeShortcut).toBe('Ctrl+Alt+X')
    for (const key of ['Z', 'Ctrl+Shift+R', 'Ctrl+Shift+P', 'Ctrl+Alt+Space', 'Ctrl+Alt+Right']) {
      expect(normalizeRecordPrefs({ retakeShortcut: key }).retakeShortcut).toBe('Ctrl+Alt+Z')
    }
  })
})
