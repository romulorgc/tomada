import { describe, expect, it } from 'vitest'
import { ASSEMBLY_NAME, ENCODED_COMMAND, createFakeMicVolume, createMicVolumeService, fakeMicVolumeFromEnv, parseMicDevices } from '../../src/main/mic-volume'

const script = Buffer.from(ENCODED_COMMAND, 'base64').toString('utf16le')
const output = (devices: unknown[]): string => `\n${JSON.stringify({ devices })}`
const usb = { name: 'Microfone (USB PnP Sound Device)', scalar: 0, db: 0, minDb: 0, maxDb: 23.8125, stepDb: 0.1875, muted: false, isDefault: true }
const emeet = { name: 'Microfone (EMEET SmartCam C60E 4K)', scalar: 0.85, db: 8, minDb: 0, maxDb: 10, stepDb: 1, muted: false, isDefault: false }

describe('volume de entrada do Windows (WASAPI) sem shell', () => {
  it('o comando é uma constante: sem texto do renderer, só variáveis de ambiente', () => {
    expect(script).toContain('$env:TOMADA_MIC_ACTION')
    expect(script).toContain('IAudioEndpointVolume')
    expect(script).not.toMatch(/Invoke-Expression|iex |Start-Process|DownloadString/i)
    expect(ASSEMBLY_NAME).toMatch(/^tomada-mic-[0-9a-f]{12}\.dll$/)
  })

  it('lê a lista, tolera ruído antes do JSON e recusa o que não é a lista', () => {
    expect(parseMicDevices(`aviso\n${JSON.stringify({ devices: [usb] })}`)).toHaveLength(1)
    expect(() => parseMicDevices('sem json')).toThrow(/lista de microfones/)
    expect(() => parseMicDevices(JSON.stringify({ devices: [{ name: 'x' }] }))).toThrow()
  })

  it('read escolhe o aparelho do rótulo e passa dados só por variáveis de ambiente', async () => {
    const calls: Record<string, string>[] = []
    const svc = createMicVolumeService({ platform: 'win32', cacheDir: 'C:/tmp/x', run: async (env) => { calls.push(env); return output([usb, emeet]) } })
    expect((await svc.read('Microfone (EMEET SmartCam C60E 4K) (328f:00f3)'))?.scalar).toBe(0.85)
    expect(calls[0]).toMatchObject({ TOMADA_MIC_ACTION: 'list', TOMADA_MIC_NAME: '' })
  })

  it('setDb manda o nome saneado e o ganho, e devolve o estado lido depois', async () => {
    const calls: Record<string, string>[] = []
    const svc = createMicVolumeService({ platform: 'win32', cacheDir: 'C:/tmp/x', run: async (env) => { calls.push(env); return output([{ ...usb, db: 23.8125, scalar: 1 }, emeet]) } })
    const after = await svc.setDb('Padrão - Microfone (USB PnP Sound Device) (08bb:2902)', 23.8125)
    expect(calls[0]).toMatchObject({ TOMADA_MIC_ACTION: 'set', TOMADA_MIC_NAME: 'Microfone (USB PnP Sound Device)', TOMADA_MIC_DB: '23.813' })
    expect(after?.scalar).toBe(1)
    expect(await svc.setDb('x', Number.NaN)).toBeNull()
  })

  it('fora do Windows não consulta nada; erro do PowerShell vira null e fica no log', async () => {
    let ran = 0
    expect(await createMicVolumeService({ platform: 'linux', run: async () => { ran++; return '' } }).read('x')).toBeNull()
    expect(ran).toBe(0)
    const warnings: string[] = []
    const broken = createMicVolumeService({ platform: 'win32', cacheDir: 'C:/tmp/x', run: async () => { throw new Error('falhou') }, logger: { warn: (m) => { warnings.push(m) } } })
    expect(await broken.read('Padrão - X')).toBeNull()
    expect(warnings).toHaveLength(1)
  })

  it('o aparelho de teste mapeia o ganho, limita à faixa e lembra o que foi pedido', async () => {
    const fake = createFakeMicVolume({ name: 'Teste', db: 0, minDb: 0, maxDb: 20 })
    expect((await fake.read('qualquer'))?.scalar).toBe(0)
    expect((await fake.setDb('qualquer', 50))?.db).toBe(20)
    expect(fake.state().scalar).toBe(1)
    expect(fake.requested).toEqual([50])
    expect(fakeMicVolumeFromEnv(undefined)).toBeNull()
    expect(fakeMicVolumeFromEnv('{"db":"x"}')).toBeNull()
    expect(fakeMicVolumeFromEnv('{"name":"A","db":0,"minDb":0,"maxDb":10}')?.state().name).toBe('A')
  })
})
