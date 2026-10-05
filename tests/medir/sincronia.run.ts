/** Medição explícita com os dados locais do usuário; nenhum arquivo pessoal entra em tests/. */
import { join } from 'node:path'
import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { it } from 'vitest'
import { ensureToolsDir } from '../../src/main/transcription/tools-dir'
import { createFfmpeg, locateFfmpeg } from '../../src/main/ffmpeg'
import { runProcess } from '../../src/main/process-runner'
import { resolveProjectFile } from '../../src/main/project-files'
import { launchTomada, waitForAux } from '../e2e/helpers'
import { ROOT } from '../helpers/fs'

it('registra a confiança nas gravações locais e tenta uma captura nova no app', async () => {
  const base = ensureToolsDir()
  const ff = createFfmpeg(locateFfmpeg()!)
  const temporary = join(base, 'tmp', `s1-medicao-${Date.now()}`)
  await mkdir(temporary, { recursive: true })
  const measure = async (video: string, audio?: string) => {
    const result = await runProcess(join(base, 'python', 'Scripts', 'python.exe'), ['-I', join(ROOT, 'resources', 'lip_sync.py')], {
      stdin: JSON.stringify({ video, audio, ffmpeg: ff.paths.ffmpeg, model: join(base, 'lip-sync', 'syncnet_v2.model') }),
      timeoutMs: 180_000, env: { PYTHONUTF8: '1' }
    })
    return JSON.parse(result.stdout)
  }
  const evidence: Record<string, unknown> = {}
  try {
    for (const folder of ['2026-07-26-12-59-14', '2026-07-26-13-57-59']) {
      const video = join(ROOT, 'gravacoes', folder, 'camera.mp4')
      const original = await measure(video)
      const injections = []
      for (const delayMs of [100, -100]) {
        const audio = join(temporary, `${folder}-${delayMs}.wav`)
        await ff.run(['-i', video, '-vn', '-af', delayMs > 0 ? 'adelay=100:all=1' : 'atrim=start=0.1,asetpts=PTS-STARTPTS,apad=pad_dur=0.1', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audio])
        injections.push({ audioDelayMs: delayMs, ...(await measure(video, audio)) })
        await rm(audio)
      }
      evidence[folder] = { original, injections }
      console.log(`[S1 gravação local ${folder}] ${JSON.stringify(evidence[folder])}`)
    }
    // Captura por MediaRecorder dentro do Tomada, com dispositivos reais e sem transcrever a voz.
    const capture = join(temporary, 'captura-nova')
    await mkdir(join(capture, 'projetos'), { recursive: true })
    const session = await launchTomada({ base: capture, seed: false, realDevices: true, env: { TOMADA_TOOLS_DIR: base } })
    try {
      await session.page.getByTestId('nav-record').click()
      await session.page.getByTestId('mode-camera').click()
      await session.page.getByTestId('camera-preview').waitFor({ state: 'visible', timeout: 20_000 })
      await session.page.waitForFunction(() => document.querySelector('[data-testid="camera-preview"]')?.getAttribute('data-live') === 'true', undefined, { timeout: 20_000 })
      await session.page.getByTestId('record-start').click()
      const bar = await waitForAux(session.app, 'bar')
      await new Promise((resolve) => setTimeout(resolve, 12_000))
      await bar.getByTestId('bar-stop').click()
      await session.page.getByTestId('project-view').waitFor({ state: 'visible', timeout: 120_000 })
      const projects = await readdir(session.projects)
      const dir = join(session.projects, projects[0]!)
      const project = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'))
      const video = await resolveProjectFile(dir, project.sources.camera.path, 'sources.camera.path')
      const audio = project.sources.voice ? await resolveProjectFile(dir, project.sources.voice.path, 'sources.voice.path') : undefined
      evidence.capturaNova = { measurement: await measure(video, audio), sync: project.sync }
      await ff.run(['-ss', '5', '-i', video, '-frames:v', '1', join(temporary, 'inspecao-webcam.jpg')])
      console.log(`[S1 captura nova] ${JSON.stringify(evidence.capturaNova)}`)
      console.log(`[S1 inspeção local] ${join(temporary, 'inspecao-webcam.jpg')}`)
    } catch (error) {
      evidence.capturaNova = { unavailable: error instanceof Error ? error.message : String(error) }
      console.log(`[S1 captura nova indisponível] ${JSON.stringify(evidence.capturaNova)}`)
    } finally {
      await session.close({ keep: true })
    }
  } finally {
    // Só números e motivos; os dados de câmera permanecem na pasta local de ferramentas.
    await writeFile(join(base, 'lip-sync', 'medicao-local.json'), JSON.stringify(evidence, null, 2))
  }
}, 900_000)
