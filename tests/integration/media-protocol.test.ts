import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { mediaUrl } from '@shared/media-url'
import { handleMediaRequest } from '../../src/main/media-protocol'
import { FIX, useTmpDir } from '../helpers/env'

const tmp = useTmpDir()
const FOLDER = 'Projeto nº 1 ação'

let root = ''
let outside = ''
let pattern: Buffer // 1000 bytes com padrão conhecido
let mp4: Buffer

const get = (path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Response> =>
  handleMediaRequest(new Request(`tomada-media://project${path}`, { method, headers }), root)

beforeAll(() => {
  root = tmp()
  outside = tmp()
  const media = join(root, FOLDER, 'media')
  mkdirSync(media, { recursive: true })
  pattern = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251))
  writeFileSync(join(media, 'dados.bin'), pattern)
  copyFileSync(join(FIX.exemplo, 'media', 'screen.mp4'), join(media, 'screen.mp4'))
  copyFileSync(join(FIX.exemplo, 'media', 'thumb.jpg'), join(media, 'thumb.jpg'))
  mp4 = readFileSync(join(media, 'screen.mp4'))
  writeFileSync(join(outside, 'segredo.txt'), 'não pode sair daqui')
  // junção para fora da raiz (não precisa de administrador no Windows)
  symlinkSync(outside, join(root, FOLDER, 'atalho'), 'junction')
})

const url = (file: string): string => mediaUrl(FOLDER, file).replace('tomada-media://project', '')

describe('protocolo tomada-media: leitura', () => {
  it('GET sem Range: 200, tamanho certo, corpo idêntico ao arquivo, anuncia Range', async () => {
    const res = await get(url('media/screen.mp4'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-length')).toBe(String(mp4.length))
    expect(Buffer.from(await res.arrayBuffer()).equals(mp4)).toBe(true)
  })

  it('Range de começo e fim: 206 com Content-Range certo e exatamente os bytes pedidos', async () => {
    const res = await get(url('media/dados.bin'), { Range: 'bytes=10-109' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 10-109/1000')
    expect(res.headers.get('content-length')).toBe('100')
    expect(Buffer.from(await res.arrayBuffer()).equals(pattern.subarray(10, 110))).toBe(true)
  })

  it('Range aberto (bytes=900-): até o último byte', async () => {
    const res = await get(url('media/dados.bin'), { Range: 'bytes=900-' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 900-999/1000')
    expect(Buffer.from(await res.arrayBuffer()).equals(pattern.subarray(900))).toBe(true)
  })

  it('Range de sufixo (bytes=-100): os últimos bytes', async () => {
    const res = await get(url('media/dados.bin'), { Range: 'bytes=-100' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 900-999/1000')
    expect(Buffer.from(await res.arrayBuffer()).equals(pattern.subarray(900))).toBe(true)
  })

  it('Range de um byte só', async () => {
    const res = await get(url('media/dados.bin'), { Range: 'bytes=0-0' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-0/1000')
    expect([...Buffer.from(await res.arrayBuffer())]).toEqual([pattern[0]])
  })

  it('fim além do arquivo é limitado (206 até o último byte)', async () => {
    const res = await get(url('media/dados.bin'), { Range: 'bytes=990-99999' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 990-999/1000')
  })

  it('Range de um MP4 de verdade (como o <video> faz): início e fim do arquivo', async () => {
    const head = await get(url('media/screen.mp4'), { Range: 'bytes=0-' })
    expect(head.status).toBe(206)
    expect(head.headers.get('content-range')).toBe(`bytes 0-${mp4.length - 1}/${mp4.length}`)
    const tail = await get(url('media/screen.mp4'), { Range: 'bytes=-4096' })
    expect(tail.status).toBe(206)
    expect(Buffer.from(await tail.arrayBuffer()).equals(mp4.subarray(mp4.length - 4096))).toBe(true)
  })

  it('Range impossível: 416 com Content-Range */tamanho', async () => {
    for (const range of ['bytes=1000-', 'bytes=5000-6000', 'bytes=500-100', 'bytes=0-1,5-9']) {
      const res = await get(url('media/dados.bin'), { Range: range })
      expect(res.status, range).toBe(416)
      expect(res.headers.get('content-range'), range).toBe('bytes */1000')
    }
  })

  it('HEAD: cabeçalhos sem corpo', async () => {
    const res = await get(url('media/dados.bin'), {}, 'HEAD')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('1000')
    expect(await res.text()).toBe('')
  })

  it('tipo de conteúdo por extensão', async () => {
    expect((await get(url('media/thumb.jpg'))).headers.get('content-type')).toBe('image/jpeg')
    expect((await get(url('media/dados.bin'))).headers.get('content-type')).toBe('application/octet-stream')
  })

  it('CORS liberado (a M2 lê quadros num worker) e OPTIONS responde', async () => {
    const res = await get(url('media/dados.bin'))
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const pre = await get(url('media/dados.bin'), {}, 'OPTIONS')
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-headers')).toBe('Range')
  })
})

describe('protocolo tomada-media: barreiras', () => {
  it('arquivo que não existe: 404', async () => {
    expect((await get(url('media/nao-existe.mp4'))).status).toBe(404)
    expect((await get('/pasta-que-nao-existe/media/a.mp4')).status).toBe(404)
  })

  it('pasta no lugar de arquivo: 404', async () => {
    expect((await get(url('media'))).status).toBe(404)
  })

  it('`..` e separadores escondidos: 403, mesmo que o alvo exista fora da raiz', async () => {
    const escape = encodeURIComponent('..')
    for (const path of [
      `/${encodeURIComponent(FOLDER)}/a%2f${escape}%2f${escape}%2fsegredo.txt`,
      `/${encodeURIComponent(FOLDER)}/a%5c${escape}%5c${escape}%5csegredo.txt`,
      `/${encodeURIComponent(FOLDER)}/%2e%2e%2f%2e%2e%2fsegredo.txt`,
      `/${encodeURIComponent(FOLDER)}/C%3A/Windows/win.ini`,
      `/${encodeURIComponent(FOLDER)}/media/dados.bin%3Ads`
    ]) {
      const res = await get(path)
      expect(res.status, path).toBe(403)
      expect(await res.text()).not.toContain('não pode sair')
    }
  })

  it('o URL com `..` literal é normalizado pelo próprio URL e nunca sai da raiz', async () => {
    // /pasta/../../x → /x (1 segmento) → barrado
    const res = await get(`/${encodeURIComponent(FOLDER)}/../../segredo.txt`)
    expect([403, 404]).toContain(res.status)
    expect(await res.text()).not.toContain('não pode sair')
  })

  it('junção que aponta para fora da raiz: 403 (nada de vazar arquivo de fora)', async () => {
    const res = await get(`/${encodeURIComponent(FOLDER)}/atalho/segredo.txt`)
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('não pode sair')
  })

  it('método que não é leitura: 405', async () => {
    const res = await get(url('media/dados.bin'), {}, 'POST')
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toContain('GET')
  })

  it('host errado: 403', async () => {
    const res = await handleMediaRequest(new Request(`tomada-media://outro/${encodeURIComponent(FOLDER)}/media/dados.bin`), root)
    expect(res.status).toBe(403)
  })
})
