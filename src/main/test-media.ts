/**
 * Gancho de TESTE: injeta uma voz (ou uma câmera com voz) no lugar do que o microfone e a câmera gravariam, ALINHADA AO t0.
 *
 * Por quê: as flags de dispositivo falso do Chromium (`--use-fake-device-for-media-stream`) também falsificam a captura de TELA
 * (README, "Cursor sintético"), então a prova real grava a tela de verdade, SEM microfone, e entrega a narração aqui, antes do
 * processamento. Todo o resto do fluxo (relógio, rastreador, normalização, transcrição, piloto) é o real.
 *
 *  - `TOMADA_TEST_VOICE=<arquivo de áudio>`: vira `raw/mic.webm`; o passo "voz" do processamento extrai o `voice.wav` dele.
 *  - `TOMADA_TEST_CAMERA=<arquivo de vídeo com áudio>`: vira `raw/camera.webm` (imagem do rosto + voz, como a câmera+microfone do
 *    mesmo MediaRecorder); o processamento normaliza a câmera e extrai a voz como em qualquer gravação com câmera.
 *
 * O arquivo injetado começa no instante `t0` da gravação (o deslocamento da câmera fica em 0), como se o gravador o tivesse
 * entregue. Só o ambiente do processo principal liga o gancho (nunca o renderer), e a gravação ganha um aviso nas notas: ninguém
 * confunde uma gravação de teste com uma de verdade.
 */
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Size } from '@shared/types'
import type { Ffmpeg } from './ffmpeg'
import type { Logger } from './logger'
import { RAW_CAMERA, RAW_MIC, type RecordingManifest } from './manifest'
import { pathExists } from './fs-utils'
import { resolveProjectFile } from './project-files'

export const ENV_TEST_VOICE = 'TOMADA_TEST_VOICE'
export const ENV_TEST_CAMERA = 'TOMADA_TEST_CAMERA'

export type TestMediaChoice = { kind: 'voice' | 'camera'; file: string }

/** O que o ambiente pede (a câmera, que traz a voz junto, vale mais que a voz sozinha). */
export function testMediaFromEnv(env: NodeJS.ProcessEnv): TestMediaChoice | null {
  const camera = env[ENV_TEST_CAMERA]?.trim()
  if (camera) return { kind: 'camera', file: camera }
  const voice = env[ENV_TEST_VOICE]?.trim()
  if (voice) return { kind: 'voice', file: voice }
  return null
}

/**
 * Copia o arquivo para `raw/` e acerta o manifesto (a gravação passa a ter câmera ou microfone). Devolve o aviso que entrou nas notas,
 * ou `null` se o ambiente não pediu nada. Falha com o motivo (arquivo que não existe, pasta que escapa) em vez de gravar sem a mídia.
 */
export async function injectTestMedia(args: { dir: string; manifest: RecordingManifest; env: NodeJS.ProcessEnv; ffmpeg: Ffmpeg | null; logger: Logger }): Promise<string | null> {
  const choice = testMediaFromEnv(args.env)
  if (!choice) return null
  const { dir, manifest, logger } = args
  if (!(await pathExists(choice.file))) throw new Error(`O arquivo de mídia de teste não existe: ${choice.file}`)
  const rel = choice.kind === 'camera' ? RAW_CAMERA : RAW_MIC
  const target = await resolveProjectFile(dir, rel)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(choice.file, target)
  let size: Size | null = null
  if (choice.kind === 'camera' && args.ffmpeg) {
    try {
      const probe = await args.ffmpeg.probe(target)
      if (probe.video?.width && probe.video.height) size = { w: probe.video.width, h: probe.video.height }
    } catch (err) {
      logger.warn('Mídia de teste: não consegui medir a câmera injetada.', err)
    }
  }
  manifest.camera = { file: rel, mime: null, hasVideo: choice.kind === 'camera', hasAudio: true, size }
  const note = `Mídia de TESTE injetada (${choice.kind === 'camera' ? ENV_TEST_CAMERA : ENV_TEST_VOICE}): ${choice.kind === 'camera' ? 'a câmera e a voz' : 'a voz'} desta gravação não vieram do microfone nem da câmera, e sim de um arquivo, alinhado ao início da gravação.`
  manifest.notes.push(note)
  logger.warn(note)
  return note
}
