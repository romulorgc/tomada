import type { FileHandle } from 'node:fs/promises'
import { pcmWavHeader, PCM_HEADER_BYTES, PCM_SAMPLE_RATE } from '@shared/pcm'

/** Cabeçalho atualizado por bloco: WAV utilizável mesmo após interrupção. */
export async function checkpointPcm(handle: FileHandle, totalBytes: number): Promise<void> {
  const dataBytes = totalBytes - PCM_HEADER_BYTES
  if (dataBytes < 0 || dataBytes % 4 !== 0 || dataBytes > 0xffffffff - 36) throw new Error('O WAV PCM tem tamanho inválido ou ultrapassou o limite de 6 horas. Pare e comece outra gravação.')
  const header = new Uint8Array(pcmWavHeader(PCM_SAMPLE_RATE, dataBytes))
  let done = 0
  while (done < header.length) {
    const result = await handle.write(header, done, header.length - done, done)
    if (result.bytesWritten === 0) throw new Error('O disco não aceitou o cabeçalho do microfone PCM.')
    done += result.bytesWritten
  }
  await handle.datasync()
}
export async function validatePcmHeader(handle: FileHandle): Promise<void> {
  const header = Buffer.alloc(PCM_HEADER_BYTES)
  let done = 0
  while (done < header.length) {
    const result = await handle.read(header, done, header.length - done, done)
    if (!result.bytesRead) break
    done += result.bytesRead
  }
  if (done !== header.length || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 16) !== 'WAVEfmt ' || header.readUInt32LE(16) !== 16 || header.readUInt16LE(20) !== 3 || header.readUInt16LE(22) !== 1 || header.readUInt32LE(24) !== PCM_SAMPLE_RATE || header.readUInt32LE(28) !== PCM_SAMPLE_RATE * 4 || header.readUInt16LE(32) !== 4 || header.readUInt16LE(34) !== 32 || header.toString('ascii', 36, 40) !== 'data') throw new Error('O cabeçalho do microfone PCM está inválido. O bruto foi preservado.')
}
