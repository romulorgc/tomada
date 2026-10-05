/**
 * Segurança (revisão de 05/10): os canais de IPC com os serviços de VERDADE (handlers, armazenamento de projetos,
 * exportação com ffmpeg real, mídias derivadas) e um projeto "de terceiros" que aponta para fora da própria pasta.
 * O renderer é tratado como menos confiável que o processo principal: caminho que vem dele ou do `project.json` nunca vale.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { outputFrameCount } from '@shared/export'
import type { ExportRequest } from '@shared/ipc'
import { parseProject, projectDurationMs, serializeProject } from '@shared/project'
import { outputDuration } from '@shared/timeline'
import type { Project } from '@shared/types'
import { createDerivedMedia } from '../../src/main/derived-media'
import { createExportService, type ExportService } from '../../src/main/export-service'
import { locateFfmpeg } from '../../src/main/ffmpeg'
import { createHandlers, type HandlerDeps } from '../../src/main/handlers'
import { createMemoryLogger } from '../../src/main/logger'
import { ENV_PROJECTS_DIR } from '../../src/main/paths'
import { createOutputDirs } from '../../src/main/path-guard'
import { createProjectStore } from '../../src/main/projects'
import { createAppState } from '../../src/main/state'
import { copyTree, FIX, requireFfmpeg, useTmpDir } from '../helpers/env'
import { transcriptionDeps } from '../helpers/handler-extras'
import { createIdleRecordingService } from '../helpers/recording'

const tmp = useTmpDir()
const ID = 'exemplo'
const EXAMPLE = parseProject(readFileSync(join(FIX.exemplo, 'project.json'), 'utf8'))
const MSG_FORA = /Este projeto aponta para um arquivo fora da pasta dele/

type Over = {
  /** O que o diálogo nativo de pasta de exportação devolve. */
  exportDir?: string | null
  projectsDir?: string | null
  ffmpeg?: string | null
  /** Quando a janela escondida abre (simulada): o que ela faz. */
  onWindow?: (id: string, svc: ExportService) => void
}

async function build(over: Over = {}) {
  const base = tmp()
  const root = join(base, 'projetos')
  const dir = join(root, ID)
  copyTree(FIX.exemplo, dir)
  const outside = join(base, 'fora')
  mkdirSync(outside)
  copyTree(join(FIX.exemplo, 'media'), join(outside, 'media'))
  const logger = createMemoryLogger()
  const state = await createAppState({ file: join(base, 'settings.json'), env: { ...process.env, [ENV_PROJECTS_DIR]: root }, logger })
  const store = createProjectStore({ root: () => state.projectsRoot(), logger, trash: async () => undefined, openFolder: async () => undefined })
  const outputDirs = createOutputDirs()
  const ff = requireFfmpeg()
  const ref: { svc: ExportService | null } = { svc: null }
  const exporter = createExportService({
    logger,
    outputDirs,
    read: (id) => store.read(id),
    ffmpeg: () => ff,
    openExporterWindow: (id) => {
      const svc = ref.svc!
      if (over.onWindow) setTimeout(() => over.onWindow!(id, svc), 20)
      return { destroy: () => undefined }
    },
    emit: () => undefined,
    now: () => performance.now()
  })
  ref.svc = exporter
  const derived = createDerivedMedia({ logger, ffmpeg: () => ff, read: (id) => store.read(id) })
  const calls: string[] = []
  const deps: HandlerDeps = {
    info: { name: 'Tomada', version: '0.0.0', platform: 'win32', electron: '40', userDataDir: base, logsDir: base },
    state,
    store,
    logger,
    pickFolder: async () => over.projectsDir ?? null,
    pickFfmpeg: async () => over.ffmpeg ?? null,
    recording: createIdleRecordingService(),
    exporter,
    derived,
    ...transcriptionDeps({ state, store, logger }),
    outputDirs,
    pickExportDir: async () => over.exportDir ?? null,
    pickImage: async () => null,
    openPath: async (p) => void calls.push(`open ${p}`),
    revealPath: async (p) => void calls.push(`reveal ${p}`),
    copyText: (t) => void calls.push(`copy ${t}`),
    finishCountdown: () => undefined,
    clock: () => 0
  }
  const handlers = createHandlers(deps)
  const editProject = (edit: (p: Project) => void): void => {
    const file = join(dir, 'project.json')
    const p = parseProject(readFileSync(file, 'utf8'))
    edit(p)
    writeFileSync(file, serializeProject(p))
  }
  return { base, root, dir, outside, handlers, exporter, derived, state, store, calls, editProject, outputDirs, logger }
}

const request = (over: Partial<ExportRequest> = {}): ExportRequest => ({ projectId: ID, resolution: '1080p', fps: 30, ...over })

/** Vídeo mudo H.264 de 30 qps com exatamente `frames` quadros (o que a janela escondida entregaria). */
function fakeVideo(file: string, frames: number): Buffer {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30', '-frames:v', String(frames), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', file], { windowsHide: true })
  return readFileSync(file)
}

/** Janela simulada que entrega um vídeo válido. `before` roda antes de entregar (para simular algo que acontece no meio da exportação). */
function deliveringWindow(base: string, project: Project, before?: () => void): NonNullable<Over['onWindow']> {
  const frames = outputFrameCount(outputDuration(projectDurationMs(project), project.cuts), 30)
  return (id, svc) => {
    void (async () => {
      before?.()
      await svc.write(id, 0, new Uint8Array(fakeVideo(join(base, `video-${id.slice(0, 6)}.mp4`), frames)))
      svc.finish(id, { ok: true, frames, encoder: 'teste' })
    })()
  }
}

describe('files:open e files:reveal (IPC)', () => {
  it('não abre executável nem script, nem dentro da pasta dos projetos; o programa padrão nunca é chamado', async () => {
    const { handlers, dir, calls } = await build()
    for (const name of ['malvado.exe', 'malvado.bat', 'malvado.lnk', 'malvado.ps1', 'malvado.cmd']) {
      writeFileSync(join(dir, name), 'x')
      await expect(handlers['files:open'](join(dir, name)), name).rejects.toThrow(/Só abro arquivos de mídia/)
    }
    expect(calls).toEqual([])
  })

  it('não abre mídia de fora da pasta dos projetos, nem por "..", nem pela junção', async () => {
    const { handlers, dir, outside, calls } = await build()
    await expect(handlers['files:open'](join(outside, 'media', 'screen.mp4'))).rejects.toThrow(/não está na pasta dos projetos/)
    await expect(handlers['files:open'](join(dir, '..', '..', 'fora', 'media', 'screen.mp4'))).rejects.toThrow(/não está na pasta dos projetos/)
    symlinkSync(outside, join(dir, 'atalho'), 'junction')
    await expect(handlers['files:open'](join(dir, 'atalho', 'media', 'screen.mp4'))).rejects.toThrow(/não está na pasta dos projetos/)
    await expect(handlers['files:open']('relativo\\screen.mp4')).rejects.toThrow(/caminho completo/)
    expect(calls).toEqual([])
  })

  it('abre mídia da pasta dos projetos', async () => {
    const { handlers, dir, calls } = await build()
    const file = join(dir, 'media', 'screen.mp4')
    await handlers['files:open'](file)
    expect(calls).toEqual([`open ${file}`])
  })

  it('files:reveal mostra a pasta dos projetos e nada de fora', async () => {
    const { handlers, dir, outside, calls } = await build()
    await handlers['files:reveal'](dir)
    await handlers['files:reveal'](join(dir, 'media', 'screen.mp4'))
    expect(calls).toEqual([`reveal ${dir}`, `reveal ${join(dir, 'media', 'screen.mp4')}`])
    await expect(handlers['files:reveal'](outside)).rejects.toThrow(/não vou mostrá-lo/)
    await expect(handlers['files:reveal']('C:\\Windows\\System32')).rejects.toThrow(/não vou mostrá-lo/)
    expect(calls).toHaveLength(2)
  })

  it('o vídeo exportado numa pasta escolhida pelo usuário abre e se mostra (só ele, e só depois de concluído nesta sessão)', async () => {
    const out = join(tmp(), 'Saída do usuário')
    mkdirSync(out)
    const { handlers, exporter, calls } = await build({ exportDir: out, onWindow: deliveringWindow(tmp(), EXAMPLE) })
    const picked = await handlers['export:pick-dir']()
    expect(picked).toBe(out)
    const { exportId } = await handlers['export:start'](request({ dir: out, fileName: 'Aula final' }))
    expect(exportId).toBeTruthy()
    await exporter.idle()
    const status = exporter.status()!
    expect(status.phase, status.message).toBe('done')
    const file = status.outputPath!
    expect(file).toBe(join(out, 'Aula final.mp4'))
    // nenhum temporário sobrou: só o vídeo e o texto de publicação que acompanha o 16:9 (M4b)
    expect(readdirSync(out).sort()).toEqual(['Aula final.mp4', 'Projeto de exemplo - YouTube.txt'])
    await handlers['files:open'](file)
    await handlers['files:reveal'](file)
    await handlers['files:reveal'](out)
    expect(calls).toEqual([`open ${file}`, `reveal ${file}`, `reveal ${out}`])
    // outro arquivo da mesma pasta, que não é saída desta sessão, não
    writeFileSync(join(out, 'outro.mp4'), 'x')
    await expect(handlers['files:open'](join(out, 'outro.mp4'))).rejects.toThrow(/não está na pasta dos projetos/)
    expect(await realpath(file)).toBeTruthy()
  }, 180_000)
})

describe('export:start (IPC): onde a exportação pode gravar', () => {
  it('pasta que o usuário NÃO escolheu nesta sessão é recusada, e nada é criado lá', async () => {
    const { handlers, base } = await build()
    const intrusa = join(base, 'nao-aprovada', 'sub')
    await expect(handlers['export:start'](request({ dir: intrusa }))).rejects.toThrow(/não foi escolhida por você nesta sessão/)
    expect(existsSync(join(base, 'nao-aprovada'))).toBe(false)
    await expect(handlers['export:start'](request({ dir: 'relativa\\pasta' }))).rejects.toThrow(/caminho completo/)
    expect(await handlers['export:status']()).toBeNull()
  })

  it('aprovar uma pasta não aprova as vizinhas nem as de dentro dela', async () => {
    const out = join(tmp(), 'aprovada')
    mkdirSync(join(out, 'sub'), { recursive: true })
    const { handlers, exporter } = await build({ exportDir: out })
    expect(await handlers['export:pick-dir']()).toBe(out)
    await expect(handlers['export:start'](request({ dir: join(out, 'sub') }))).rejects.toThrow(/não foi escolhida/)
    await expect(handlers['export:start'](request({ dir: dirname(out) }))).rejects.toThrow(/não foi escolhida/)
    const { exportId } = await handlers['export:start'](request({ dir: out })) // esta vale
    await handlers['export:cancel'](exportId)
    await exporter.idle()
    expect(readdirSync(out).sort()).toEqual(['sub'])
  }, 60_000)

  it('o que o diálogo devolve vazio (cancelou) não aprova nada', async () => {
    const { handlers, base } = await build({ exportDir: null })
    expect(await handlers['export:pick-dir']()).toBeNull()
    await expect(handlers['export:start'](request({ dir: join(base, 'qualquer') }))).rejects.toThrow(/não foi escolhida/)
  })

  it('a pasta exports/ do projeto vale sem escolher; se ela for um atalho para fora, é recusada', async () => {
    const a = await build()
    const { exportId } = await a.handlers['export:start'](request())
    await a.handlers['export:cancel'](exportId)
    await a.exporter.idle()
    expect(existsSync(join(a.dir, 'exports'))).toBe(true)

    const b = await build()
    symlinkSync(b.outside, join(b.dir, 'exports'), 'junction')
    await expect(b.handlers['export:start'](request())).rejects.toThrow(/exports\/ deste projeto aponta para fora/)
    expect(readdirSync(b.outside).sort()).toEqual(['media'])
  }, 60_000)

  it('o nome do arquivo não escapa da pasta: separador, "..", nome reservado e extensão são saneados', async () => {
    const out = join(tmp(), 'saida')
    mkdirSync(out)
    const ctx = await build({ exportDir: out, onWindow: deliveringWindow(tmp(), EXAMPLE) })
    await ctx.handlers['export:pick-dir']()
    await ctx.handlers['export:start'](request({ dir: out, fileName: '..\\..\\fora\\CON.exe' }))
    await ctx.exporter.idle()
    const status = ctx.exporter.status()!
    expect(status.phase, status.message).toBe('done')
    const all = readdirSync(out)
    const written = all.filter((n) => n.endsWith('.mp4'))
    expect(all.filter((n) => !n.endsWith('.mp4'))).toEqual(['Projeto de exemplo - YouTube.txt']) // o texto de publicação (M4b)
    expect(written).toHaveLength(1)
    expect(written[0]).toMatch(/\.mp4$/)
    expect(written[0]).not.toMatch(/[\\/:]|\.\./)
    expect(status.outputPath!.startsWith(`${out}\\`)).toBe(true)
    expect(existsSync(join(dirname(out), 'fora'))).toBe(false)
  }, 180_000)

  it('NUNCA sobrescreve: um arquivo que aparece com o nome escolhido no meio da exportação fica intacto e o novo ganha " (2)"', async () => {
    const out = join(tmp(), 'saida')
    mkdirSync(out)
    const taken = join(out, 'Aula.mp4')
    const ctx = await build({ exportDir: out, onWindow: deliveringWindow(tmp(), EXAMPLE, () => writeFileSync(taken, 'ARQUIVO DO USUARIO')) })
    await ctx.handlers['export:pick-dir']()
    await ctx.handlers['export:start'](request({ dir: out, fileName: 'Aula' }))
    await ctx.exporter.idle()
    const status = ctx.exporter.status()!
    expect(status.phase, status.message).toBe('done')
    expect(readFileSync(taken, 'utf8')).toBe('ARQUIVO DO USUARIO')
    expect(status.outputPath).toBe(join(out, 'Aula (2).mp4'))
    expect(readdirSync(out).sort()).toEqual(['Aula (2).mp4', 'Aula.mp4', 'Projeto de exemplo - YouTube.txt'])
  }, 180_000)

  it('exportação que FALHA não apaga o arquivo do usuário que tomou o nome no meio do caminho', async () => {
    const out = join(tmp(), 'saida')
    mkdirSync(out)
    const taken = join(out, 'Aula.mp4')
    const ctx = await build({
      exportDir: out,
      onWindow: (id, svc) => {
        writeFileSync(taken, 'ARQUIVO DO USUARIO')
        svc.finish(id, { ok: false, message: 'falha simulada' })
      }
    })
    await ctx.handlers['export:pick-dir']()
    await ctx.handlers['export:start'](request({ dir: out, fileName: 'Aula' }))
    await ctx.exporter.idle()
    expect(ctx.exporter.status()!.phase).toBe('error')
    expect(readFileSync(taken, 'utf8')).toBe('ARQUIVO DO USUARIO')
    expect(readdirSync(out)).toEqual(['Aula.mp4']) // e o temporário foi embora
  }, 120_000)
})

describe('caminhos do project.json de terceiros', () => {
  it('export:start recusa mídia que aponta para fora da pasta, com a frase certa, e não deixa rastro', async () => {
    for (const bad of ['..\\fora\\media\\voice.wav', 'C:\\Windows\\win.ini', '\\\\servidor\\pasta\\voz.wav', '../fora/media/voice.wav', 'http://127.0.0.1:9/voz.wav']) {
      const { handlers, editProject, dir, exporter } = await build()
      editProject((p) => {
        p.sources.voice!.path = bad
      })
      await expect(handlers['export:start'](request()), bad).rejects.toThrow(MSG_FORA)
      expect(existsSync(join(dir, 'exports')), bad).toBe(false)
      expect(exporter.status(), bad).toBeNull()
    }
  })

  it('export:start recusa a tela, a câmera, o som do sistema e a imagem de fundo que escapam', async () => {
    for (const edit of [
      (p: Project) => void (p.sources.screen!.path = '..\\fora\\media\\screen.mp4'),
      (p: Project) => void (p.sources.camera!.path = '..\\fora\\media\\camera.mp4'),
      (p: Project) => void (p.sources.system = { path: '..\\fora\\media\\voice.wav', w: 0, h: 0, fps: 0, durationMs: 1000 }),
      (p: Project) => void (p.style.background = { type: 'image', path: 'https://exemplo.com/fundo.png' }),
      (p: Project) => void (p.style.background = { type: 'image', path: 'file:///C:/Windows/win.ini' })
    ]) {
      const { handlers, editProject } = await build()
      editProject(edit)
      await expect(handlers['export:start'](request())).rejects.toThrow(MSG_FORA)
    }
  })

  it('export:start recusa o que sai da pasta pela junção (realpath), não só pelo texto', async () => {
    const { handlers, dir, outside } = await build()
    symlinkSync(outside, join(dir, 'espelho'), 'junction')
    const file = join(dir, 'project.json')
    const p = parseProject(readFileSync(file, 'utf8'))
    p.sources.voice!.path = 'espelho/media/voice.wav'
    writeFileSync(file, serializeProject(p))
    await expect(handlers['export:start'](request())).rejects.toThrow(MSG_FORA)
  })

  it('projects:get recusa abrir o projeto e diz por quê (erro visível, não "arquivo não encontrado")', async () => {
    const { handlers, editProject } = await build()
    editProject((p) => {
      p.sources.screen!.path = '..\\fora\\media\\screen.mp4'
    })
    await expect(handlers['projects:get'](ID)).rejects.toThrow(MSG_FORA)
  })

  it('projects:get recusa imagem de fundo de fora (http:, file:, data:, absoluto)', async () => {
    for (const path of ['http://127.0.0.1:9/x.png', 'https://exemplo.com/x.png', 'file:///C:/Windows/win.ini', 'data:image/png;base64,AAAA', 'C:\\Windows\\x.png', '..\\fora\\x.png']) {
      const { handlers, editProject } = await build()
      editProject((p) => {
        p.style.background = { type: 'image', path }
      })
      await expect(handlers['projects:get'](ID), path).rejects.toThrow(MSG_FORA)
    }
  })

  it('projects:get abre o projeto normal e devolve as URLs do protocolo', async () => {
    const { handlers } = await build()
    const d = await handlers['projects:get'](ID)
    expect(d.media.screen?.url).toContain('tomada-media://project/exemplo/media/screen.mp4')
    expect(d.events.cursor).toContain('events/cursor.jsonl')
  })

  it('projects:save não grava documento com caminho que escapa (a interface não é confiável), e o arquivo fica intacto', async () => {
    const { handlers, dir } = await build()
    const file = join(dir, 'project.json')
    const before = readFileSync(file, 'utf8')
    const project = (await handlers['projects:get'](ID)).project
    for (const edit of [
      (p: Project) => void (p.sources.voice!.path = '..\\..\\x.wav'),
      (p: Project) => void (p.style.background = { type: 'image', path: 'http://127.0.0.1:9/x.png' }),
      (p: Project) => void (p.sources.screen!.path = 'C:\\Windows\\x.mp4')
    ]) {
      const bad = structuredClone(project)
      edit(bad)
      await expect(handlers['projects:save'](ID, bad)).rejects.toThrow(MSG_FORA)
    }
    expect(readFileSync(file, 'utf8')).toBe(before)
    const ok = structuredClone(project)
    ok.title = 'Novo título'
    expect((await handlers['projects:save'](ID, ok)).title).toBe('Novo título')
  })

  it('mídias derivadas (forma de onda, voz da prévia, miniaturas) recusam caminho de fora e NÃO leem o arquivo de lá', async () => {
    for (const field of ['voice', 'screen'] as const) {
      const { derived, editProject } = await build()
      editProject((p) => {
        p.sources[field]!.path = '..\\fora\\media\\' + (field === 'voice' ? 'voice.wav' : 'screen.mp4')
      })
      if (field === 'voice') {
        await expect(derived.peaks(ID)).rejects.toThrow(MSG_FORA)
        await expect(derived.previewAudio(ID)).rejects.toThrow(MSG_FORA)
      } else {
        await expect(derived.thumbs(ID)).rejects.toThrow(MSG_FORA)
      }
    }
  })

  it('mídias derivadas: a pasta media/ que é junção para fora não recebe arquivo nenhum', async () => {
    const { derived, dir, outside } = await build()
    // troca media/ por uma junção para a cópia de fora (que tem os mesmos arquivos, então só a ESCRITA denuncia)
    const { renameSync } = await import('node:fs')
    renameSync(join(dir, 'media'), join(dir, 'media-velha'))
    symlinkSync(join(outside, 'media'), join(dir, 'media'), 'junction')
    const before = readdirSync(join(outside, 'media')).sort()
    await expect(derived.peaks(ID)).rejects.toThrow(MSG_FORA)
    await expect(derived.thumbs(ID)).rejects.toThrow(MSG_FORA)
    expect(readdirSync(join(outside, 'media')).sort()).toEqual(before)
  })

  it('id de projeto que foge da raiz é recusado em todos os canais (`projects:get("..\\\\..\\\\x")`)', async () => {
    const { handlers } = await build()
    const asyncCall = async <T,>(fn: () => T): Promise<Awaited<T>> => await fn()
    for (const id of ['..\\..\\x', '../../x', '..', '...', 'abc.', 'C:\\Windows', 'CON', 'a/b', '']) {
      await expect(asyncCall(() => handlers['projects:get'](id)), id).rejects.toThrow(/Identificador de projeto inválido/)
      await expect(asyncCall(() => handlers['projects:trash'](id)), id).rejects.toThrow(/Identificador de projeto inválido/)
      await expect(asyncCall(() => handlers['projects:rename'](id, 'x')), id).rejects.toThrow(/Identificador de projeto inválido/)
      await expect(asyncCall(() => handlers['projects:reveal'](id)), id).rejects.toThrow(/Identificador de projeto inválido/)
      await expect(asyncCall(() => handlers['projects:pick-background'](id)), id).rejects.toThrow(/Identificador de projeto inválido/)
      await expect(asyncCall(() => handlers['derived:peaks'](id)), id).rejects.toThrow(/Identificador de projeto inválido/)
      if (id !== '') await expect(asyncCall(() => handlers['export:start'](request({ projectId: id }))), id).rejects.toThrow(/Identificador de projeto inválido/)
    }
  })

  it('pasta de projeto que é junção para fora da raiz não é lida, gravada nem mandada para a Lixeira', async () => {
    const { handlers, root, outside } = await build()
    copyTree(FIX.exemplo, join(outside, 'projeto-de-fora'))
    symlinkSync(join(outside, 'projeto-de-fora'), join(root, 'intruso'), 'junction')
    await expect(handlers['projects:get']('intruso')).rejects.toThrow(/aponta para fora da pasta dos projetos/)
    await expect(handlers['projects:rename']('intruso', 'x')).rejects.toThrow(/aponta para fora da pasta dos projetos/)
    await expect(handlers['projects:trash']('intruso')).rejects.toThrow(/aponta para fora da pasta dos projetos/)
    expect(existsSync(join(outside, 'projeto-de-fora', 'project.json'))).toBe(true)
  })
})

describe('settings:update (IPC): ajuste que vira caminho só vale se veio do diálogo nativo', () => {
  it('ffmpegPath: um executável qualquer NÃO pode virar o "ffmpeg" (executaria programa arbitrário)', async () => {
    const real = locateFfmpeg()!
    const { handlers, state } = await build({ ffmpeg: dirname(real.ffmpeg) })
    await expect(handlers['settings:update']({ ffmpegPath: 'C:\\Windows\\System32\\cmd.exe' })).rejects.toThrow(/não foi escolhido por você nesta sessão/)
    await expect(handlers['settings:update']({ ffmpegPath: dirname(real.ffmpeg) })).rejects.toThrow(/não foi escolhido por você nesta sessão/) // nem o certo, se não passou pelo diálogo
    expect(state.settings().ffmpegPath).toBeUndefined()
    const picked = await handlers['settings:pick-ffmpeg']()
    expect(picked).toBe(dirname(real.ffmpeg))
    expect((await handlers['settings:update']({ ffmpegPath: picked! })).settings.ffmpegPath).toBe(dirname(real.ffmpeg))
    // o ajuste escolhido pode ser limpo
    expect((await handlers['settings:update']({ ffmpegPath: '' })).settings.ffmpegPath).toBeUndefined()
  })

  it('projectsDir: só a pasta devolvida pelo diálogo; relativa, de rede e "a mesma com outro texto" não', async () => {
    const nova = join(tmp(), 'Meus Projetos')
    mkdirSync(nova)
    const { handlers, state } = await build({ projectsDir: nova })
    for (const bad of [nova, 'C:\\', 'C:\\Windows', '\\\\servidor\\pasta', 'relativa']) {
      await expect(handlers['settings:update']({ projectsDir: bad }), bad).rejects.toThrow(/não foi escolhido por você nesta sessão|completo/)
    }
    expect(state.settings().projectsDir).toBeUndefined()
    const picked = await handlers['settings:pick-projects-dir']()
    expect(picked).toBe(nova)
    expect((await handlers['settings:update']({ projectsDir: nova.toUpperCase() })).settings.projectsDir).toBe(nova.toUpperCase()) // o Windows não distingue maiúsculas
    await expect(handlers['settings:update']({ projectsDir: join(nova, '..') })).rejects.toThrow(/não foi escolhido/)
  })

  it('o diálogo cancelado (null) não libera nada', async () => {
    const { handlers } = await build({ projectsDir: null, ffmpeg: null })
    expect(await handlers['settings:pick-projects-dir']()).toBeNull()
    expect(await handlers['settings:pick-ffmpeg']()).toBeNull()
    await expect(handlers['settings:update']({ projectsDir: 'C:\\x' })).rejects.toThrow(/não foi escolhido/)
  })
})

describe('outros canais que recebem número ou texto livre', () => {
  it('exporter:write recusa posição negativa, fracionária, gigante ou dados que não são bytes', async () => {
    const { handlers } = await build()
    for (const position of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, 129 * 1024 ** 3]) {
      await expect(Promise.resolve().then(() => handlers['exporter:write']('x', position, new Uint8Array(1))), String(position)).rejects.toThrow(/Posição de escrita inválida/)
    }
    await expect(Promise.resolve().then(() => handlers['exporter:write']('x', 0, 'texto' as never))).rejects.toThrow(/Dados de escrita inválidos/)
  })

  it('bar:action só aceita as ações da barra; record:pause e record:resume só aceitam número', async () => {
    const { handlers } = await build()
    await expect(handlers['bar:action']('apagar-tudo' as never)).rejects.toThrow(/Ação da barra desconhecida/)
    await expect(Promise.resolve().then(() => handlers['record:pause']('agora' as never))).rejects.toThrow(/Valor inválido/)
    await expect(Promise.resolve().then(() => handlers['record:resume'](Number.NaN))).rejects.toThrow(/Valor inválido/)
  })
})
