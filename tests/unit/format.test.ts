import { describe, expect, it } from 'vitest'
import { formatBytes, formatDate, formatDateTime, formatDuration, formatSpan, formatTimecode } from '@shared/format'

describe('formatDuration', () => {
  it('formata m:ss', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(5000)).toBe('0:05')
    expect(formatDuration(65_000)).toBe('1:05')
    expect(formatDuration(599_000)).toBe('9:59')
    expect(formatDuration(600_000)).toBe('10:00')
  })
  it('trunca os milissegundos', () => {
    expect(formatDuration(1999)).toBe('0:01')
    expect(formatDuration(59_999)).toBe('0:59')
  })
  it('usa h:mm:ss a partir de uma hora', () => {
    expect(formatDuration(3_600_000)).toBe('1:00:00')
    expect(formatDuration(3_725_000)).toBe('1:02:05')
    expect(formatDuration(36_000_000)).toBe('10:00:00')
  })
  it('valor inválido ou negativo vira 0:00', () => {
    expect(formatDuration(-1)).toBe('0:00')
    expect(formatDuration(Number.NaN)).toBe('0:00')
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0:00')
  })
})

describe('formatBytes', () => {
  it('bytes inteiros sem casa decimal', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })
  it('usa vírgula decimal e base 1024', () => {
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('1,5 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB')
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1,5 MB')
    expect(formatBytes(2.25 * 1024 ** 3)).toBe('2,3 GB')
  })
  it('arredondamento que atinge 1024 sobe de unidade', () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe('1 MB')
  })
  it('inválido ou negativo vira 0 B', () => {
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })
})

describe('formatDate / formatDateTime (pt-BR)', () => {
  const iso = '2026-10-04T18:30:00.000Z'
  it('data em dd/mm/aaaa no fuso informado', () => {
    expect(formatDate(iso, { timeZone: 'America/Sao_Paulo' })).toBe('04/10/2026')
  })
  it('data e hora', () => {
    expect(formatDateTime(iso, { timeZone: 'America/Sao_Paulo' })).toBe('04/10/2026 às 15:30')
    expect(formatDateTime(iso, { timeZone: 'UTC' })).toBe('04/10/2026 às 18:30')
  })
  it('o fuso muda o dia quando precisa', () => {
    expect(formatDate('2026-10-05T01:00:00.000Z', { timeZone: 'America/Sao_Paulo' })).toBe('04/10/2026')
  })
  it('data inválida vira travessão', () => {
    expect(formatDate('não é data')).toBe('—')
    expect(formatDateTime('')).toBe('—')
  })
})

describe('formatTimecode (relógio do editor)', () => {
  it('m:ss.cc com centésimos, arredondado', () => {
    expect(formatTimecode(0)).toBe('0:00.00')
    expect(formatTimecode(3200)).toBe('0:03.20')
    expect(formatTimecode(65_432)).toBe('1:05.43')
    expect(formatTimecode(999)).toBe('0:01.00') // arredonda para cima sem virar "0:00.100"
    expect(formatTimecode(3_723_450)).toBe('1:02:03.45')
  })
  it('valor inválido ou negativo vira zero', () => {
    expect(formatTimecode(-5)).toBe('0:00.00')
    expect(formatTimecode(Number.NaN)).toBe('0:00.00')
  })
})

describe('formatSpan (duração em palavras)', () => {
  it('abaixo de um minuto, em segundos com vírgula', () => {
    expect(formatSpan(400)).toBe('0,4 s')
    expect(formatSpan(3200)).toBe('3,2 s')
    expect(formatSpan(2000)).toBe('2 s')
    expect(formatSpan(0)).toBe('0 s')
  })
  it('de um minuto em diante, minutos e segundos', () => {
    expect(formatSpan(65_000)).toBe('1 min 05 s')
    expect(formatSpan(3_660_000)).toBe('1 h 01 min')
  })
})
