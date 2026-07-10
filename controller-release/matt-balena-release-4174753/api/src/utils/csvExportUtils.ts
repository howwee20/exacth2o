import { createGzip } from 'zlib'
import { once } from 'events'

export const EXPORT_CHUNK_SIZE = 2000

export const formatDateInCentralTime = (value: Date | string): string => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(date)
  const lookup = new Map(parts.map((part) => [part.type, part.value]))
  return `${lookup.get('year')}-${lookup.get('month')}-${lookup.get('day')} ${lookup.get('hour')}:${lookup.get('minute')}:${lookup.get('second')}`
}

export const escapeCsvValue = (value: string | number | boolean | null): string => {
  if (value === null || value === undefined) return ''
  const stringValue = String(value)
  if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
    return `"${stringValue.replace(/"/g, '""')}"`
  }
  return stringValue
}

export const writeToGzip = async (gzip: ReturnType<typeof createGzip>, chunk: string) => {
  if (!gzip.write(chunk)) {
    await once(gzip, 'drain')
  }
}
