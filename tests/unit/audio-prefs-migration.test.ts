import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMemoryLogger } from '../../src/main/logger'
import { createAppState } from '../../src/main/state'

describe('migração persistida dos filtros do microfone', () => {
  it('desliga a supressão antiga uma vez, registra nota e preserva escolha posterior ao reabrir', async () => {
    const root = resolve('test-results/tmp')
    await mkdir(root, { recursive: true })
    const dir = await mkdtemp(join(root, 'audio-prefs-'))
    try {
      const file = join(dir, 'settings.json')
      await writeFile(file, JSON.stringify({ record: { noiseSuppression: true, micId: 'microfone-teste', fps: 60 }, dictionary: ['Tomada'] }))
      const logger = createMemoryLogger()
      const first = await createAppState({ file, env: {}, logger })
      expect(first.recordPrefs()).toMatchObject({ noiseSuppression: false, micId: 'microfone-teste', fps: 60 })
      const saved = JSON.parse(await readFile(file, 'utf8'))
      expect(saved.record.audioPrefsVersion).toBe(1)
      expect(saved.dictionary).toEqual(['Tomada'])
      expect(logger.entries.filter((e) => /supressão.*migra/i.test(e.message))).toHaveLength(1)
      const afterMigration = createMemoryLogger()
      const second = await createAppState({ file, env: {}, logger: afterMigration })
      expect(second.recordPrefs().noiseSuppression).toBe(false)
      expect(afterMigration.entries.filter((e) => /supressão.*migra/i.test(e.message))).toHaveLength(0)
      await second.updateRecordPrefs({ noiseSuppression: true })
      const third = await createAppState({ file, env: {}, logger: createMemoryLogger() })
      expect(third.recordPrefs().noiseSuppression).toBe(true)
      expect(JSON.parse(await readFile(file, 'utf8')).record.audioPrefsVersion).toBe(1)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('instalação nova começa sem supressão e guarda o marco antes da primeira escolha', async () => {
    const root = resolve('test-results/tmp')
    await mkdir(root, { recursive: true })
    const dir = await mkdtemp(join(root, 'audio-prefs-'))
    try {
      const file = join(dir, 'settings.json')
      const first = await createAppState({ file, env: {}, logger: createMemoryLogger() })
      expect(first.recordPrefs().noiseSuppression).toBe(false)
      expect(JSON.parse(await readFile(file, 'utf8')).record.audioPrefsVersion).toBe(1)
      await first.updateRecordPrefs({ noiseSuppression: true })
      const reopened = await createAppState({ file, env: {}, logger: createMemoryLogger() })
      expect(reopened.recordPrefs().noiseSuppression).toBe(true)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
