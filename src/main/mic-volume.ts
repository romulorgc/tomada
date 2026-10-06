/**
 * Volume de ENTRADA do Windows de um microfone (WASAPI, IAudioEndpointVolume).
 *
 * O volume do aparelho decide o quanto de ganho a voz recebe ANTES de chegar ao app: com 0% a voz sai uns 40 dB abaixo do
 * ideal, a exportação sobe tudo com o `loudnorm` e o chiado sobe junto. Por isso a tela Gravar lê esse volume e, a pedido,
 * sobe sozinha até a fala chegar ao nível certo.
 *
 * Sem shell: um PowerShell com `-EncodedCommand` FIXO (este arquivo) e os dados (ação, nome, dB) por variáveis de ambiente.
 * O nome do aparelho vem do renderer: é saneado aqui, nunca vira texto de comando. A saída é JSON só com ASCII.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { microphoneBaseName, pickMicrophone, type MicVolumeInfo } from '@shared/mic-level'

export type { MicVolumeInfo }

export interface MicVolumeService {
  /** `null` quando não é Windows, o aparelho não foi achado ou o Windows recusou. */
  read(label: string): Promise<MicVolumeInfo | null>
  /** Muda o ganho do aparelho (limitado à faixa dele) e devolve o estado lido DEPOIS da mudança. */
  setDb(label: string, db: number): Promise<MicVolumeInfo | null>
}

const infoSchema = z.object({
  name: z.string(), scalar: z.number().finite(), db: z.number().finite(), minDb: z.number().finite(), maxDb: z.number().finite(),
  stepDb: z.number().finite(), muted: z.boolean(), isDefault: z.boolean()
})
const outputSchema = z.object({ devices: z.array(infoSchema).max(64) })

// ---------------------------------------------------------------------------------------------------------------------
// O script. C# com COM puro (sem pacote): enumera os aparelhos de captura ativos e lê/escreve o ganho mestre.
// PROPVARIANT tem 24 bytes em 64 bits; o tamanho fixo maior evita estourar a memória em qualquer arquitetura.

const CSHARP = String.raw`
using System; using System.Collections.Generic; using System.Globalization; using System.Runtime.InteropServices; using System.Text;
namespace TomadaMic {
  [StructLayout(LayoutKind.Sequential)] public struct PropertyKey { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit, Size = 24)] public struct PropVariant { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr ptr; }
  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore { int GetCount(out uint c); int GetAt(uint i, out PropertyKey k); int GetValue(ref PropertyKey k, out PropVariant v); int SetValue(ref PropertyKey k, ref PropVariant v); int Commit(); }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice { int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); int OpenPropertyStore(int access, out IPropertyStore s); int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id); int GetState(out int st); }
  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection { int GetCount(out uint c); int Item(uint i, out IMMDevice d); }
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator { int EnumAudioEndpoints(int flow, int mask, out IMMDeviceCollection c); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice d); int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice d); int RegisterEndpointNotificationCallback(IntPtr p); int UnregisterEndpointNotificationCallback(IntPtr p); }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
  [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr n); int UnregisterControlChangeNotify(IntPtr n); int GetChannelCount(out uint c);
    int SetMasterVolumeLevel(float db, ref Guid ctx); int SetMasterVolumeLevelScalar(float v, ref Guid ctx);
    int GetMasterVolumeLevel(out float db); int GetMasterVolumeLevelScalar(out float v);
    int SetChannelVolumeLevel(uint ch, float db, ref Guid ctx); int SetChannelVolumeLevelScalar(uint ch, float v, ref Guid ctx);
    int GetChannelVolumeLevel(uint ch, out float db); int GetChannelVolumeLevelScalar(uint ch, out float v);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool m, ref Guid ctx); int GetMute([MarshalAs(UnmanagedType.Bool)] out bool m);
    int GetVolumeStepInfo(out uint s, out uint n); int VolumeStepUp(ref Guid ctx); int VolumeStepDown(ref Guid ctx);
    int QueryHardwareSupport(out uint mask); int GetVolumeRange(out float min, out float max, out float inc);
  }
  public static class Mic {
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant v);
    static string Esc(string s) { var b = new StringBuilder("\""); foreach (char c in s) { if (c == '"' || c == '\\') b.Append('\\').Append(c); else if (c < 32 || c > 126) b.Append("\\u").Append(((int)c).ToString("x4")); else b.Append(c); } return b.Append('"').ToString(); }
    static string Num(float v) { return v.ToString("0.######", CultureInfo.InvariantCulture); }
    static string NameOf(IMMDevice d) {
      IPropertyStore store; if (d.OpenPropertyStore(0, out store) != 0) return "";
      var key = new PropertyKey { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
      PropVariant v; if (store.GetValue(ref key, out v) != 0) return "";
      try { return v.vt == 31 && v.ptr != IntPtr.Zero ? Marshal.PtrToStringUni(v.ptr) : ""; } finally { PropVariantClear(ref v); }
    }
    static IAudioEndpointVolume Volume(IMMDevice d) { var iid = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A"); object o; if (d.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) return null; return (IAudioEndpointVolume)o; }
    static string Json(string name, IAudioEndpointVolume v, bool isDefault) {
      float db, sc, mn, mx, st; bool mute;
      if (v.GetMasterVolumeLevel(out db) != 0 || v.GetMasterVolumeLevelScalar(out sc) != 0 || v.GetVolumeRange(out mn, out mx, out st) != 0 || v.GetMute(out mute) != 0) return null;
      return "{\"name\":" + Esc(name) + ",\"scalar\":" + Num(sc) + ",\"db\":" + Num(db) + ",\"minDb\":" + Num(mn) + ",\"maxDb\":" + Num(mx) + ",\"stepDb\":" + Num(st) + ",\"muted\":" + (mute ? "true" : "false") + ",\"isDefault\":" + (isDefault ? "true" : "false") + "}";
    }
    public static string Run(string action, string wanted, string dbText) {
      var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
      IMMDevice def = null; string defId = ""; try { if (en.GetDefaultAudioEndpoint(1, 0, out def) == 0 && def != null) def.GetId(out defId); } catch { }
      IMMDeviceCollection col; if (en.EnumAudioEndpoints(1, 1, out col) != 0) return "{\"devices\":[]}";
      uint n; col.GetCount(out n); var items = new List<string>();
      for (uint i = 0; i < n; i++) {
        IMMDevice d; if (col.Item(i, out d) != 0) continue; string id; d.GetId(out id); string name = NameOf(d); var vol = Volume(d); if (vol == null) continue;
        if (action == "set" && string.Equals(name, wanted, StringComparison.OrdinalIgnoreCase)) {
          float mn, mx, st; float want = float.Parse(dbText, CultureInfo.InvariantCulture);
          if (vol.GetVolumeRange(out mn, out mx, out st) == 0) { var ctx = Guid.Empty; vol.SetMasterVolumeLevel(Math.Min(mx, Math.Max(mn, want)), ref ctx); }
        }
        var j = Json(name, vol, id == defId); if (j != null) items.Add(j);
      }
      return "{\"devices\":[" + string.Join(",", items.ToArray()) + "]}";
    }
  }
}
`

const POWERSHELL = `$ErrorActionPreference = 'Stop'
$dll = $env:TOMADA_MIC_DLL
if (-not (Test-Path -LiteralPath $dll)) {
  $source = @'${CSHARP}'@
  $partial = $dll + '.' + $PID + '.tmp'
  Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $partial
  Move-Item -LiteralPath $partial -Destination $dll -Force -ErrorAction SilentlyContinue
  if (-not (Test-Path -LiteralPath $dll)) { $dll = $partial }
}
Add-Type -LiteralPath $dll
[Console]::Out.Write([TomadaMic.Mic]::Run($env:TOMADA_MIC_ACTION, $env:TOMADA_MIC_NAME, $env:TOMADA_MIC_DB))`

/** O comando é uma constante: nada do renderer entra nele. */
export const ENCODED_COMMAND = Buffer.from(POWERSHELL, 'utf16le').toString('base64')
/** O assembly compilado fica em cache (a compilação leva ~3 s; depois cada consulta leva menos de 1 s). O nome carrega o hash do código. */
export const ASSEMBLY_NAME = `tomada-mic-${createHash('sha256').update(CSHARP).digest('hex').slice(0, 12)}.dll`

type Runner = (env: Record<string, string>) => Promise<string>

function powershellPath(): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

const runPowerShell: Runner = (env) => new Promise((resolve, reject) => {
  execFile(powershellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED_COMMAND],
    { env: { ...process.env, ...env }, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 },
    (err, stdout, stderr) => err ? reject(new Error(`${err.message} ${String(stderr).slice(0, 300)}`.trim())) : resolve(String(stdout)))
})

export type MicVolumeOptions = { platform?: NodeJS.Platform; run?: Runner; cacheDir?: string; logger?: { warn(message: string, detail?: unknown): void } }

export function parseMicDevices(stdout: string): MicVolumeInfo[] {
  const start = stdout.indexOf('{')
  if (start < 0) throw new Error('O Windows não devolveu a lista de microfones.')
  return outputSchema.parse(JSON.parse(stdout.slice(start))).devices
}

/** Uma chamada por pedido (o Add-Type leva ~1 s): a tela Gravar lê a cada poucos segundos e o ajuste faz poucos passos. */
export function createMicVolumeService(options: MicVolumeOptions = {}): MicVolumeService {
  const platform = options.platform ?? process.platform
  const run = options.run ?? runPowerShell
  const dll = join(options.cacheDir ?? join(tmpdir(), 'tomada-mic'), ASSEMBLY_NAME)
  // Um pedido de cada vez: a primeira chamada compila o assembly e as outras só o carregam.
  let chain: Promise<unknown> = Promise.resolve()
  const query = (action: 'list' | 'set', name: string, db = ''): Promise<MicVolumeInfo[]> => {
    const next = chain.then(async () => {
      try {
        mkdirSync(join(dll, '..'), { recursive: true })
        return parseMicDevices(await run({ TOMADA_MIC_ACTION: action, TOMADA_MIC_NAME: name, TOMADA_MIC_DB: db, TOMADA_MIC_DLL: dll }))
      } catch (err) { options.logger?.warn('Não consegui consultar o volume de entrada do Windows.', err); return [] as MicVolumeInfo[] }
    })
    chain = next
    return next
  }
  return {
    async read(label) {
      if (platform !== 'win32') return null
      return pickMicrophone(await query('list', ''), label)
    },
    async setDb(label, db) {
      if (platform !== 'win32' || !Number.isFinite(db)) return null
      // Uma única chamada: o script só muda o aparelho cujo nome EXATO é este e limita o ganho à faixa dele.
      const devices = await query('set', microphoneBaseName(label), db.toFixed(3))
      return pickMicrophone(devices, label)
    }
  }
}

/**
 * Teste (`TOMADA_TEST_MIC_VOLUME=<json>`): um aparelho em memória. Nada toca o volume real do Windows e o e2e consegue
 * conferir o que o "Ajustar sozinho" pediu. O ganho mapeia linearmente para a escala 0..1.
 */
export function createFakeMicVolume(initial: Partial<MicVolumeInfo> = {}): MicVolumeService & { state(): MicVolumeInfo; requested: number[] } {
  const minDb = initial.minDb ?? 0, maxDb = initial.maxDb ?? 23.8125
  let db = Math.min(maxDb, Math.max(minDb, initial.db ?? minDb))
  const requested: number[] = []
  const state = (): MicVolumeInfo => ({ name: initial.name ?? 'Microfone de teste', scalar: maxDb > minDb ? (db - minDb) / (maxDb - minDb) : 1, db, minDb, maxDb,
    stepDb: initial.stepDb ?? 0.1875, muted: initial.muted ?? false, isDefault: true })
  return {
    state, requested,
    read: async () => state(),
    setDb: async (_label, value) => { requested.push(value); db = Math.min(maxDb, Math.max(minDb, value)); return state() }
  }
}

/** O JSON do ambiente de teste, validado: números finitos ou o campo é ignorado. */
export function fakeMicVolumeFromEnv(json: string | undefined): (MicVolumeService & { state(): MicVolumeInfo; requested: number[] }) | null {
  if (!json) return null
  const parsed = z.object({ name: z.string().max(200).optional(), db: z.number().finite().optional(), minDb: z.number().finite().optional(), maxDb: z.number().finite().optional(),
    stepDb: z.number().finite().positive().optional(), muted: z.boolean().optional() }).safeParse(JSON.parse(json))
  return parsed.success ? createFakeMicVolume(parsed.data) : null
}
