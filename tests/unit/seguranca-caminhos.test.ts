/**
 * Segurança (revisão de 05/10): caminhos que vêm do documento ou da interface, nomes de arquivo, argumentos do
 * ffmpeg, navegação e CSP. Tudo o que dá para decidir só olhando o texto.
 */
import { describe, expect, it } from 'vitest'
import { createProject } from '@shared/project'
import { buildCsp, CSP_DIRECTIVES } from '@shared/csp'
import { exportFileName, sanitizeFileName } from '@shared/export'
import { assertMediaUrl, isMediaUrl, mediaUrl } from '@shared/media-url'
import {
  OUTSIDE_PROJECT_MESSAGE,
  assertDocumentPathsSafe,
  assertSafeRelativePath,
  documentFilePaths,
  isReservedWindowsName,
  isSafeRelativePath,
  unsafeRelativePathReason
} from '@shared/safe-path'
import { buildAudioArgs, buildMeasureArgs, buildMuxArgs, buildSilentAudioArgs } from '../../src/main/audio-graph'
import { createFfmpeg } from '../../src/main/ffmpeg'
import { assertFfmpegPath } from '../../src/main/ffmpeg-path'
import { buildExtractAudioArgs, buildNormalizeVideoArgs, buildPeaksPcmArgs, buildThumbnailArgs, buildThumbStripArgs } from '../../src/main/ffmpeg-args'
import { isAppOrigin, isAppUrl, isExternalRequest } from '../../src/main/navigation'
import { assertProjectId } from '../../src/main/projects'

describe('caminho relativo do documento (isSafeRelativePath)', () => {
  it.each(['media/screen.mp4', 'media\\voice.wav', 'events/cursor.jsonl', 'media/fundo-ab12cd34.png', 'Gravação/ç é.mp4', './media/x.mp4', 'a.b/c.d'])(
    'aceita %s',
    (rel) => {
      expect(isSafeRelativePath(rel)).toBe(true)
    }
  )

  it.each([
    ['absoluto com unidade', 'C:\\Windows\\win.ini'],
    ['absoluto com unidade e barra normal', 'C:/Windows/win.ini'],
    ['só a unidade', 'C:x.mp4'],
    ['absoluto posix', '/etc/passwd'],
    ['raiz com contrabarra', '\\Windows\\win.ini'],
    ['UNC', '\\\\servidor\\pasta\\x.mp4'],
    ['UNC com barras normais', '//servidor/pasta/x.mp4'],
    ['prefixo de dispositivo', '\\\\?\\C:\\x.mp4'],
    ['sobe de pasta', '..\\x.mp4'],
    ['sobe no meio', 'media/../../x.mp4'],
    ['termina em ..', 'media/..'],
    ['só ..', '..'],
    ['só .', '.'],
    ['vazio', ''],
    ['http', 'http://127.0.0.1/x.png'],
    ['https', 'https://exemplo.com/x.png'],
    ['file', 'file:///C:/Windows/win.ini'],
    ['data', 'data:image/png;base64,AAAA'],
    ['concat do ffmpeg', 'concat:a.mp4|b.mp4'],
    ['pipe do ffmpeg', 'pipe:0'],
    ['fluxo alternativo do NTFS', 'media/screen.mp4:fluxo'],
    ['nome com .. e espaço (o Windows descarta o espaço)', 'media/.. /x.mp4'],
    ['nome com três pontos', 'media/.../x.mp4'],
    ['nome que termina em ponto', 'media/x.mp4.'],
    ['nome que termina em espaço', 'media/x.mp4 '],
    ['dispositivo CON', 'CON'],
    ['dispositivo com extensão', 'media/nul.mp4'],
    ['dispositivo COM1', 'media/com1.txt'],
    ['caractere de controle', 'media/a\u0000b.mp4'],
    ['curinga', 'media/*.mp4'],
    ['termina em barra', 'media/'],
    ['longo demais', `media/${'x'.repeat(2000)}.mp4`]
  ])('recusa %s', (_why, rel) => {
    expect(isSafeRelativePath(rel)).toBe(false)
    expect(() => assertSafeRelativePath(rel)).toThrow(OUTSIDE_PROJECT_MESSAGE)
  })

  it('o que não é texto não passa', () => {
    for (const bad of [undefined, null, 42, {}, ['media/a.mp4']]) expect(isSafeRelativePath(bad)).toBe(false)
    expect(unsafeRelativePathReason(undefined)).toMatch(/não é um texto/)
  })

  it('a mensagem diz o campo e o caminho', () => {
    expect(() => assertSafeRelativePath('..\\x.mp4', 'sources.voice.path')).toThrow(/Este projeto aponta para um arquivo fora da pasta dele: sources\.voice\.path "\.\.\\\\x\.mp4"/)
  })

  it('nomes reservados do Windows (com ou sem extensão)', () => {
    for (const name of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'com9', 'LPT1', 'con.txt', 'nul.tar.gz', 'COM1.']) expect(isReservedWindowsName(name), name).toBe(true)
    for (const name of ['console', 'media', 'com10', 'auxiliar.mp4', 'a.con', '']) expect(isReservedWindowsName(name), name).toBe(false)
  })
})

describe('caminhos do documento (assertDocumentPathsSafe)', () => {
  const doc = () =>
    createProject({
      title: 't',
      sources: {
        screen: { path: 'media/screen.mp4', w: 1, h: 1, fps: 30, durationMs: 1000 },
        voice: { path: 'media/voice.wav', w: 0, h: 0, fps: 0, durationMs: 1000 }
      }
    })

  it('lista mídias e imagem de fundo', () => {
    const p = doc()
    p.style.background = { type: 'image', path: 'media/fundo-ab.png' }
    expect(documentFilePaths(p).map((x) => x.field)).toEqual(['sources.screen.path', 'sources.voice.path', 'style.background.path'])
    expect(() => assertDocumentPathsSafe(p)).not.toThrow()
  })

  it('recusa mídia e imagem de fundo que escapam, dizendo o campo', () => {
    const a = doc()
    a.sources.voice!.path = '..\\..\\segredo.wav'
    expect(() => assertDocumentPathsSafe(a)).toThrow(/sources\.voice\.path/)
    const b = doc()
    b.sources.screen!.path = 'C:\\Windows\\x.mp4'
    expect(() => assertDocumentPathsSafe(b)).toThrow(OUTSIDE_PROJECT_MESSAGE)
    const c = doc()
    c.style.background = { type: 'image', path: 'http://127.0.0.1:9/x.png' }
    expect(() => assertDocumentPathsSafe(c)).toThrow(/style\.background\.path/)
  })
})

describe('URL do protocolo de mídia (mediaUrl)', () => {
  it('monta a URL de um caminho relativo, com acento e espaço codificados', () => {
    expect(mediaUrl('2026 pasta', 'media/screen.mp4')).toBe('tomada-media://project/2026%20pasta/media/screen.mp4')
    expect(mediaUrl('p', 'media\\a ç.mp4', 7.9)).toBe('tomada-media://project/p/media/a%20%C3%A7.mp4?v=7')
    expect(isMediaUrl(mediaUrl('p', 'a/b.mp4'))).toBe(true)
  })

  it.each(['http://127.0.0.1:1234/x.png', 'https://exemplo.com/x.png', 'file:///C:/Windows/win.ini', 'data:image/png;base64,AAAA', '..\\x.png', '../x.png', 'C:\\x.png', '\\\\srv\\x\\y.png', '//srv/x/y.png', ''])(
    'recusa %s (nada de imagem de fundo vinda de fora do projeto)',
    (rel) => {
      expect(() => mediaUrl('p', rel)).toThrow(OUTSIDE_PROJECT_MESSAGE)
    }
  )

  it('a interface só lê tomada-media://', () => {
    expect(assertMediaUrl('tomada-media://project/p/media/a.mp4')).toBe('tomada-media://project/p/media/a.mp4')
    for (const bad of ['http://127.0.0.1/x', 'https://a.b/c', 'file:///C:/x', 'data:text/plain,oi', 'blob:abc', 'ftp://a/b', 'tomada-media://outro/p/a.mp4', '', null, undefined]) {
      expect(() => assertMediaUrl(bad)).toThrow(/só lê arquivos do próprio projeto/)
    }
  })
})

describe('caminho que vai para o ffmpeg (assertFfmpegPath)', () => {
  it.each(['C:\\Users\\José\\Videos\\a b.mp4', 'C:/Videos/a.mp4', 'D:\\x', '\\\\servidor\\pasta\\a.mp4'])('aceita %s', (p) => {
    expect(assertFfmpegPath(p)).toBe(p)
  })

  it.each([
    ['opção', '-i'],
    ['opção com valor', '-filter_complex_script'],
    ['nome que começa com traço', '-evil.mp4'],
    ['relativo', 'media\\a.mp4'],
    ['relativo simples', 'a.mp4'],
    ['http', 'http://127.0.0.1/a.mp4'],
    ['concat', 'concat:a|b'],
    ['pipe', 'pipe:0'],
    ['file', 'file:C:/x.mp4'],
    ['fluxo alternativo', 'C:\\x\\a.mp4:fluxo'],
    ['dispositivo', '\\\\.\\pipe\\x'],
    ['prefixo longo', '\\\\?\\C:\\x'],
    ['vazio', ''],
    ['controle', 'C:\\a\nb.mp4']
  ])('recusa %s', (_why, p) => {
    expect(() => assertFfmpegPath(p)).toThrow(RangeError)
  })

  it('recusa o que não é texto', () => {
    for (const bad of [undefined, null, 1, ['C:\\x']]) expect(() => assertFfmpegPath(bad)).toThrow(RangeError)
  })

  it('TODO construtor de argumentos recusa entrada ou saída que viraria opção ou não é absoluta', () => {
    const ok = 'C:\\t\\a.mp4'
    for (const bad of ['-evil.mp4', 'relativo.mp4', 'http://127.0.0.1/a.mp4']) {
      expect(() => buildNormalizeVideoArgs({ input: bad, output: ok, fps: 30, encoder: 'libx264' }), `normalizar entrada ${bad}`).toThrow(RangeError)
      expect(() => buildNormalizeVideoArgs({ input: ok, output: bad, fps: 30, encoder: 'libx264' }), `normalizar saída ${bad}`).toThrow(RangeError)
      expect(() => buildExtractAudioArgs({ input: bad, output: ok, channels: 1 }), `áudio entrada ${bad}`).toThrow(RangeError)
      expect(() => buildExtractAudioArgs({ input: ok, output: bad, channels: 1 }), `áudio saída ${bad}`).toThrow(RangeError)
      expect(() => buildThumbnailArgs({ input: bad, output: ok, atMs: 0 }), `miniatura entrada ${bad}`).toThrow(RangeError)
      expect(() => buildThumbnailArgs({ input: ok, output: bad, atMs: 0 }), `miniatura saída ${bad}`).toThrow(RangeError)
      expect(() => buildPeaksPcmArgs({ input: bad, output: ok, sampleRate: 8000 }), `picos entrada ${bad}`).toThrow(RangeError)
      expect(() => buildPeaksPcmArgs({ input: ok, output: bad, sampleRate: 8000 }), `picos saída ${bad}`).toThrow(RangeError)
      expect(() => buildThumbStripArgs({ input: bad, outputPattern: ok, intervalMs: 1500, height: 120 }), `tira entrada ${bad}`).toThrow(RangeError)
      expect(() => buildMeasureArgs({ inputs: [ok, bad], graphFile: ok }), `medir entrada ${bad}`).toThrow(RangeError)
      expect(() => buildMeasureArgs({ inputs: [ok], graphFile: bad }), `medir grafo ${bad}`).toThrow(RangeError)
      expect(() => buildAudioArgs({ inputs: [bad], graphFile: ok, output: ok }), `áudio final entrada ${bad}`).toThrow(RangeError)
      expect(() => buildAudioArgs({ inputs: [ok], graphFile: bad, output: ok }), `áudio final grafo ${bad}`).toThrow(RangeError)
      expect(() => buildAudioArgs({ inputs: [ok], graphFile: ok, output: bad }), `áudio final saída ${bad}`).toThrow(RangeError)
      expect(() => buildSilentAudioArgs({ durationMs: 1000, output: bad }), `trilha muda ${bad}`).toThrow(RangeError)
      expect(() => buildMuxArgs({ video: bad, audio: ok, output: ok }), `mux vídeo ${bad}`).toThrow(RangeError)
      expect(() => buildMuxArgs({ video: ok, audio: bad, output: ok }), `mux áudio ${bad}`).toThrow(RangeError)
      expect(() => buildMuxArgs({ video: ok, audio: ok, output: bad }), `mux saída ${bad}`).toThrow(RangeError)
    }
  })

  it('o ffprobe também só recebe caminho absoluto (recusa ANTES de executar qualquer coisa)', async () => {
    const ff = createFfmpeg({ ffmpeg: 'C:\\nao\\existe\\ffmpeg.exe', ffprobe: 'C:\\nao\\existe\\ffprobe.exe', source: 'path' })
    await expect(ff.probe('-evil.mp4')).rejects.toThrow(RangeError)
    await expect(ff.probe('relativo.mp4')).rejects.toThrow(RangeError)
    await expect(ff.probe('http://127.0.0.1/a.mp4')).rejects.toThrow(RangeError)
  })
})

describe('nome do arquivo exportado (sanitizeFileName / exportFileName)', () => {
  it('nome reservado do Windows ganha "_" na parte que o Windows lê, com ou sem extensão', () => {
    expect(sanitizeFileName('CON')).toBe('CON_')
    expect(sanitizeFileName('nul')).toBe('nul_')
    expect(sanitizeFileName('COM1')).toBe('COM1_')
    expect(sanitizeFileName('con.foo')).toBe('con_.foo')
    expect(sanitizeFileName('aux.tar.gz')).toBe('aux_.tar.gz')
    expect(sanitizeFileName('Console')).toBe('Console')
  })

  it('sem separador de caminho, sem "..", sem nada que escape da pasta', () => {
    for (const evil of ['..\\..\\Windows\\evil', '../../evil', 'a/../b', '..', '...', 'C:\\Windows\\evil', '\\\\srv\\share\\evil', 'x:y', '....//....//evil']) {
      const name = exportFileName('Aula', { resolution: '1080p', fps: 30, fileName: evil })
      expect(name, evil).toMatch(/\.mp4$/)
      expect(name, evil).not.toMatch(/[\\/:]/)
      expect(name, evil).not.toContain('..')
      expect(name.startsWith('.'), evil).toBe(false)
    }
  })

  it('extensão .mp4 sempre, mesmo que peçam outra', () => {
    expect(exportFileName('Aula', { resolution: '1080p', fps: 30, fileName: 'programa.exe' })).toBe('programa.exe.mp4')
    expect(exportFileName('Aula', { resolution: '1080p', fps: 30, fileName: 'x.bat' })).toBe('x.bat.mp4')
    expect(exportFileName('Aula', { resolution: '1080p', fps: 30, fileName: 'x.MP4' })).toBe('x.mp4')
  })

  it('tamanho limitado e sem ponto ou espaço no fim', () => {
    expect(sanitizeFileName('a'.repeat(5000)).length).toBeLessThanOrEqual(120)
    expect(sanitizeFileName(`${'b'.repeat(119)}. . .`)).not.toMatch(/[. ]$/)
    expect(exportFileName('Aula', { resolution: '1080p', fps: 30, fileName: 'c'.repeat(200) }).length).toBeLessThanOrEqual(125)
  })

  it('o título do projeto passa pelo mesmo saneamento', () => {
    const name = exportFileName('..\\..\\evil:CON', { resolution: '1080p', fps: 30 })
    expect(name).not.toMatch(/[\\/:]/)
    expect(name).not.toContain('..')
  })
})

describe('id de projeto (assertProjectId)', () => {
  it.each(['2026-10-04 1500 Projeto de exemplo', 'exemplo', 'Gravação ç', 'a.b'])('aceita %s', (id) => {
    expect(() => assertProjectId(id)).not.toThrow()
  })

  it.each(['..', '.', '...', '....', '..\\..\\x', '../x', 'a/b', 'a\\b', 'C:\\x', 'C:', 'x:y', 'abc.', 'abc..', 'con', 'NUL', 'com1.x', ' x', 'x ', '', 'a\u0000b', 'a*b', 'x'.repeat(300)])(
    'recusa %j',
    (id) => {
      expect(() => assertProjectId(id)).toThrow(/Identificador de projeto inválido/)
    }
  )

  it('o que não é texto não passa', () => {
    for (const bad of [undefined, null, 1, {}, ['a']]) expect(() => assertProjectId(bad)).toThrow(/Identificador de projeto inválido/)
  })
})

describe('navegação e rede (isAppUrl, isAppOrigin, isExternalRequest)', () => {
  const packaged = { rendererUrl: undefined, rendererFile: 'C:\\Users\\José\\Downloads\\Tomada\\out\\renderer\\index.html' }
  const dev = { rendererUrl: 'http://localhost:5173/', rendererFile: packaged.rendererFile }

  it('só o index.html empacotado (qualquer #hash ou ?query) é página do app', () => {
    const base = 'file:///C:/Users/Jos%C3%A9/Downloads/Tomada/out/renderer/index.html'
    expect(isAppUrl(base, packaged)).toBe(true)
    expect(isAppUrl(`${base}#export:abc`, packaged)).toBe(true)
    expect(isAppUrl(`${base}#bar`, packaged)).toBe(true)
    expect(isAppUrl('file:///c:/users/jos%C3%A9/downloads/tomada/out/renderer/index.html', packaged)).toBe(true) // Windows não distingue maiúsculas
  })

  it.each([
    'file:///C:/Windows/win.ini',
    'file:///C:/Users/Jos%C3%A9/Downloads/Tomada/out/renderer/outra.html',
    'file:///C:/Users/Jos%C3%A9/Downloads/Tomada/out/renderer/index.html.exe',
    'file://servidor/share/index.html',
    'https://example.com/',
    'http://localhost:5173/',
    'data:text/html,<script>1</script>',
    'about:blank',
    'javascript:alert(1)',
    'tomada-media://project/p/a.mp4',
    'não é url',
    ''
  ])('barra %s', (url) => {
    expect(isAppUrl(url, packaged)).toBe(false)
  })

  it('no desenvolvimento só o servidor de desenvolvimento (mesmo host e porta) vale; nada parecido', () => {
    expect(isAppUrl('http://localhost:5173/', dev)).toBe(true)
    expect(isAppUrl('http://localhost:5173/index.html#export:1', dev)).toBe(true)
    expect(isAppUrl('http://localhost:5173.evil.com/', dev)).toBe(false)
    expect(isAppUrl('http://localhost:5174/', dev)).toBe(false)
    expect(isAppUrl('http://evil.com/?http://localhost:5173/', dev)).toBe(false)
    expect(isAppUrl('file:///C:/Windows/win.ini', dev)).toBe(false)
  })

  it('a origem de uma página de arquivo é "file:///"', () => {
    expect(isAppOrigin('file:///', packaged)).toBe(true)
    expect(isAppOrigin('https://example.com', packaged)).toBe(false)
    expect(isAppOrigin(undefined, packaged)).toBe(false)
  })

  it('requisição de rede para fora é barrada; protocolos locais passam; o servidor de desenvolvimento passa só no dev', () => {
    for (const url of ['http://127.0.0.1:8080/x', 'https://example.com/x.png', 'ws://example.com/s', 'wss://example.com/s', 'ftp://example.com/x']) {
      expect(isExternalRequest(url, packaged), url).toBe(true)
    }
    for (const url of ['tomada-media://project/p/a.mp4', 'file:///C:/x', 'blob:null/abc', 'data:image/png;base64,AAAA', 'devtools://devtools/bundled/x.js']) {
      expect(isExternalRequest(url, packaged), url).toBe(false)
    }
    expect(isExternalRequest('http://localhost:5173/@vite/client', dev)).toBe(false)
    expect(isExternalRequest('ws://localhost:5173/', dev)).toBe(false)
    expect(isExternalRequest('http://localhost:5173.evil.com/', dev)).toBe(true)
    expect(isExternalRequest('http://localhost:5173/', packaged)).toBe(true)
  })
})

describe('política de conteúdo (CSP)', () => {
  const csp = buildCsp()
  const directive = (name: string): string[] => (CSP_DIRECTIVES[name] ?? []).slice()

  it('nada de rede em nenhuma diretiva: sem http:, https:, ws:, wss:, ftp:, curinga, eval nem script inline', () => {
    expect(csp).not.toMatch(/\bhttps?:|\bwss?:|\bftp:|\*|unsafe-eval|unsafe-hashes/)
    expect(directive('script-src')).toEqual(["'self'"])
  })

  it('imagem, mídia e conexão só do app e do protocolo do projeto', () => {
    expect(directive('img-src')).toEqual(["'self'", 'data:', 'tomada-media:'])
    expect(directive('media-src')).toEqual(["'self'", 'blob:', 'tomada-media:'])
    expect(directive('connect-src')).toEqual(["'self'", 'tomada-media:'])
    expect(directive('default-src')).toEqual(["'self'"])
  })

  it('sem quadros, objetos, formulários nem base', () => {
    for (const name of ['frame-src', 'object-src', 'form-action', 'base-uri']) expect(directive(name), name).toEqual(["'none'"])
  })

  it('o texto final é uma diretiva por nome, separadas por ponto e vírgula', () => {
    expect(csp.split('; ').length).toBe(Object.keys(CSP_DIRECTIVES).length)
    expect(csp).toContain("connect-src 'self' tomada-media:")
  })
})
