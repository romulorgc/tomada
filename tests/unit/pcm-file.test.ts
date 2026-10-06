import type { FileHandle } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { checkpointPcm, validatePcmHeader } from '../../src/main/pcm-file'
import { pcmWavHeader } from '../../src/shared/pcm'

it('escrita parcial do cabeçalho só confirma checkpoint depois de todos os bytes e datasync', async () => {
  const stored = Buffer.alloc(44), positions: number[] = []
  let synced = false
  const handle = { write: async (b: Uint8Array, offset: number, length: number, position: number) => {
    positions.push(position); const n = Math.min(7, length); stored.set(b.subarray(offset, offset + n), position); return { bytesWritten: n }
  }, datasync: async () => { synced = true } } as unknown as FileHandle
  await checkpointPcm(handle, 44 + 48000 * 4)
  expect(stored).toEqual(Buffer.from(pcmWavHeader(48000, 48000 * 4)))
  expect(positions).toHaveLength(7)
  expect(synced).toBe(true)
  await expect(checkpointPcm({ write: async () => ({ bytesWritten: 0 }) } as unknown as FileHandle, 44)).rejects.toThrow(/cabeçalho/)
})
it('recusa blockAlign, byteRate e fmt corrompidos antes de reparar a gravação', async () => {
  for (const field of [16, 28, 32]) {
    const invalid = Buffer.from(pcmWavHeader()); invalid[field] = invalid[field]! ^ 1
    const handle = { read: async (b: Buffer) => { invalid.copy(b); return { bytesRead: invalid.length } } } as unknown as FileHandle
    await expect(validatePcmHeader(handle)).rejects.toThrow(/inválido/)
  }
})
