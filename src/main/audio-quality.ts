/** Mede o WAV original sem ffmpeg, reprodução ou cópia de áudio. Retém só estatísticas por 20 ms. */
import { open, type FileHandle } from 'node:fs/promises'
import { analyzeAudioQualityBlocks, measureAudioQualityBlocks, type AudioQualityBlock, type AudioQualityOptions, type AudioQualityReport } from '@shared/audio-quality'
import { resolveProjectFile } from './project-files'
export { audioQualityWarningMessages } from '@shared/audio-quality-messages'

async function readExact(file: FileHandle, size: number, position: number): Promise<Buffer> {
  const bytes = Buffer.alloc(size)
  let done = 0
  while (done < size) {
    const read = await file.read(bytes, done, size - done, position + done)
    if (!read.bytesRead) throw new Error('O WAV da voz está incompleto; não consegui medir sua qualidade.')
    done += read.bytesRead
  }
  return bytes
}

type WavInfo = { sampleRate: number; width: number; format: number; dataAt: number; dataSize: number }

async function readWavInfo(file: FileHandle): Promise<WavInfo> {
  const size = (await file.stat()).size
  const riff = await readExact(file, 12, 0)
  if (riff.toString('ascii', 0, 4) !== 'RIFF' || riff.toString('ascii', 8, 12) !== 'WAVE') throw new Error('A voz precisa estar em WAV PCM para medir a qualidade.')
  const end = riff.readUInt32LE(4) + 8
  if (end > size || end < 12) throw new Error('O WAV da voz está incompleto ou tem tamanho inválido.')
  let format: Omit<WavInfo, 'dataAt' | 'dataSize'> | null = null
  let data: Pick<WavInfo, 'dataAt' | 'dataSize'> | null = null
  for (let pos = 12; pos + 8 <= end; ) {
    const head = await readExact(file, 8, pos)
    const kind = head.toString('ascii', 0, 4)
    const chunkSize = head.readUInt32LE(4)
    const payload = pos + 8
    if (payload + chunkSize > end) throw new Error('O WAV da voz está truncado; um bloco passa do fim do arquivo.')
    if (kind === 'fmt ') {
      if (chunkSize < 16 || chunkSize > 4096) throw new Error('Cabeçalho PCM inválido no WAV da voz.')
      const fmt = await readExact(file, chunkSize, payload)
      let tag = fmt.readUInt16LE(0)
      if (tag === 0xfffe && chunkSize >= 40) {
        const pcmGuidTail = Buffer.from('000000001000800000aa00389b71', 'hex')
        if (fmt.readUInt16LE(16) < 22 || !fmt.subarray(26, 40).equals(pcmGuidTail)) throw new Error('O WAV da voz tem um formato PCM extensível não suportado.')
        tag = fmt.readUInt16LE(24)
      }
      if (fmt.readUInt16LE(2) !== 1) throw new Error('A análise de qualidade precisa do WAV mono da voz.')
      const sampleRate = fmt.readUInt32LE(4)
      const bits = fmt.readUInt16LE(14)
      if (!((tag === 1 && bits === 16) || (tag === 3 && bits === 32))) throw new Error('A análise de qualidade aceita somente WAV PCM 16 bits ou float32.')
      const width = bits / 8
      if (sampleRate < 8000 || sampleRate > 384_000 || fmt.readUInt16LE(12) !== width || fmt.readUInt32LE(8) !== sampleRate * width) throw new Error('Taxa de amostragem ou tamanho da amostra inválido no WAV da voz.')
      format = { sampleRate, width, format: tag }
    } else if (kind === 'data') data = { dataAt: payload, dataSize: chunkSize }
    if (format && data) break
    pos = payload + chunkSize + (chunkSize % 2)
  }
  if (!format || !data) throw new Error('O WAV da voz não tem cabeçalho PCM e dados de áudio completos.')
  if (data.dataSize % format.width !== 0) throw new Error('O WAV da voz está incompleto; a última amostra foi truncada.')
  return { ...format, ...data }
}

/** `relativePath` passa pelo mesmo guard dos caminhos do projeto. Regiões ativas são do tempo do WAV. */
export async function inspectProjectAudioQuality(dir: string, relativePath = 'media/voice.wav', options: AudioQualityOptions = {}): Promise<AudioQualityReport> {
  const path = await resolveProjectFile(dir, relativePath, 'sources.voice.path')
  const file = await open(path, 'r')
  try {
    const info = await readWavInfo(file)
    const perBlock = Math.max(1, Math.round(info.sampleRate * 0.02))
    const chunkBytes = perBlock * 50 * info.width
    const blocks: AudioQualityBlock[] = []
    for (let offset = 0; offset < info.dataSize; offset += chunkBytes) {
      const bytes = await readExact(file, Math.min(chunkBytes, info.dataSize - offset), info.dataAt + offset)
      const samples = new Float32Array(bytes.length / info.width)
      for (let i = 0; i < samples.length; i++) samples[i] = info.format === 3 ? bytes.readFloatLE(i * 4) : bytes.readInt16LE(i * 2) / 32768
      for (const block of measureAudioQualityBlocks(samples, info.sampleRate)) blocks.push(block)
    }
    return analyzeAudioQualityBlocks(blocks, info.sampleRate, options)
  } finally { await file.close() }
}
