/**
 * Caminho de entrada ou de saída que vai para o ffmpeg/ffprobe.
 *
 * O ffmpeg lê as opções na linha de comando: um nome que começa com `-` vira OPÇÃO (`-f`, `-filter_complex_script`…),
 * e um nome com esquema (`http:`, `concat:`, `pipe:`, `subfile:`) vira OUTRA coisa que não um arquivo (rede, leitura
 * de outro arquivo). Por isso toda entrada e toda saída passa por aqui e só segue se for um caminho ABSOLUTO do
 * disco (unidade `C:\…` ou `\\servidor\pasta\…`), já resolvido por quem montou. Sem Electron.
 */

const DRIVE = /^[A-Za-z]:[\\/]/
const UNC = /^\\\\[^\\/.?]/

export function assertFfmpegPath(path: unknown, label = 'arquivo'): string {
  if (typeof path !== 'string' || path.length === 0) throw new RangeError(`ffmpeg: o caminho de ${label} está vazio.`)
  if (path.startsWith('-')) throw new RangeError(`ffmpeg: o caminho de ${label} começa com "-" e viraria uma opção (${JSON.stringify(path)}).`)
  if (/[\u0000-\u001f]/.test(path)) throw new RangeError(`ffmpeg: o caminho de ${label} tem caracteres de controle.`)
  const absolute = DRIVE.test(path) || UNC.test(path) || (process.platform !== 'win32' && path.startsWith('/'))
  if (!absolute) throw new RangeError(`ffmpeg: o caminho de ${label} precisa ser completo (recebi ${JSON.stringify(path)}).`)
  // `:` só na unidade; depois dela seria fluxo alternativo do NTFS (arquivo.mp4:fluxo)
  if (path.indexOf(':', DRIVE.test(path) ? 2 : 0) !== -1) throw new RangeError(`ffmpeg: o caminho de ${label} tem ":" fora da unidade (${JSON.stringify(path)}).`)
  return path
}
