type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { [k: string]: JsonValue };

const TEMPORAL_KEY_RE = /(timestamp|time_stamp|time|date|start_time|end_time)/i;
const EXCEL_SERIAL_RE = /^(\d{4,5})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?$/;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function excelSerialToDate(serial: number): Date {
  // Excel day 1 is 1900-01-01; JS offset with 1899-12-30 handles Excel quirks.
  const base = new Date(Date.UTC(1899, 11, 30, 0, 0, 0));
  base.setUTCDate(base.getUTCDate() + serial);
  return base;
}

function asIsoDateTime(date: Date, timePart?: string): string {
  const y = date.getUTCFullYear();
  const m = pad2(date.getUTCMonth() + 1);
  const d = pad2(date.getUTCDate());

  if (!timePart) return `${y}-${m}-${d}`;

  const parts = timePart.split(':').map((p) => Number(p));
  const hh = pad2(parts[0] || 0);
  const mm = pad2(parts[1] || 0);
  const ss = pad2(parts[2] || 0);
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function normalizeTemporalScalar(key: string, value: JsonValue): JsonValue {
  if (!TEMPORAL_KEY_RE.test(key)) return value;

  if (typeof value === 'number' && Number.isFinite(value)) {
    const rounded = Math.trunc(value);
    if (rounded >= 20000 && rounded <= 80000) {
      return asIsoDateTime(excelSerialToDate(rounded));
    }
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    const match = trimmed.match(EXCEL_SERIAL_RE);
    if (!match) return value;

    const serial = Number(match[1]);
    if (!Number.isFinite(serial) || serial < 20000 || serial > 80000) {
      return value;
    }
    return asIsoDateTime(excelSerialToDate(serial), match[2]);
  }

  return value;
}

export function normalizeTemporalFields<T extends Record<string, unknown>>(
  record: T,
): T {
  const out: JsonObject = {};

  for (const [key, raw] of Object.entries(record)) {
    if (Array.isArray(raw)) {
      out[key] = raw.map((item) => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          return normalizeTemporalFields(item as JsonObject);
        }
        return normalizeTemporalScalar(key, item);
      });
      continue;
    }

    if (raw && typeof raw === 'object') {
      out[key] = normalizeTemporalFields(raw as JsonObject);
      continue;
    }

    out[key] = normalizeTemporalScalar(key, raw as JsonValue);
  }

  return out as T;
}
