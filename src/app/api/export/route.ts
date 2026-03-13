import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';

type ExportFormat = 'csv' | 'xlsx' | 'pdf';

type ExportRequestBody = {
  format?: ExportFormat;
  records?: Record<string, unknown>[];
  filename?: string;
};

const MAX_EXPORT_ROWS = 5000;
const PDF_MAX_ROWS = 120;
const PDF_LINE_WIDTH = 110;

function sanitizeFilename(raw: string): string {
  return raw
    .trim()
    .replace(/[^a-zA-Z0-9-_]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80);
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function truncate(value: string, max = 220): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return String(value);
  }

  if (Array.isArray(value)) {
    return truncate(
      value
        .map((item) => stringifyValue(item))
        .filter(Boolean)
        .join(' | '),
      400,
    );
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;

    if (obj._type === 'node') {
      const labels = Array.isArray(obj.labels) ? obj.labels.join(':') : 'Node';
      const props =
        obj.properties && typeof obj.properties === 'object'
          ? Object.entries(obj.properties as Record<string, unknown>)
              .map(([k, v]) => `${k}=${stringifyValue(v)}`)
              .join(', ')
          : '';
      return truncate(`(${labels}${props ? ` {${props}}` : ''})`, 400);
    }

    if (obj._type === 'relationship') {
      const rel = obj.relationshipType ? String(obj.relationshipType) : 'REL';
      const props =
        obj.properties && typeof obj.properties === 'object'
          ? Object.entries(obj.properties as Record<string, unknown>)
              .map(([k, v]) => `${k}=${stringifyValue(v)}`)
              .join(', ')
          : '';
      return truncate(`[:${rel}${props ? ` {${props}}` : ''}]`, 400);
    }

    // Neo4j path-like payloads often include start/end/segments or nodes/relationships.
    if (
      ('segments' in obj && Array.isArray(obj.segments)) ||
      ('nodes' in obj && Array.isArray(obj.nodes))
    ) {
      const raw = JSON.stringify(obj);
      return truncate(raw, 500);
    }

    try {
      return truncate(JSON.stringify(obj), 500);
    } catch {
      return '[object]';
    }
  }

  return String(value);
}

type NormalizedTable = {
  columns: string[];
  rows: Record<string, string>[];
};

function normalizeRecords(records: Record<string, unknown>[]): NormalizedTable {
  const columns = Array.from(new Set(records.flatMap((r) => Object.keys(r))));
  const rows = records.map((record) => {
    const out: Record<string, string> = {};
    columns.forEach((column) => {
      out[column] = stringifyValue(record[column]);
    });
    return out;
  });
  return { columns, rows };
}

function toCsv(table: NormalizedTable): string {
  if (!table.rows.length || !table.columns.length) return 'no_data\n';

  const header = table.columns.join(',');
  const rows = table.rows.map((record) =>
    table.columns.map((key) => csvEscape(record[key])).join(','),
  );
  return [header, ...rows].join('\n');
}

function escapePdfText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function buildSimplePdf(lines: string[]): Buffer {
  const contentLines: string[] = ['BT', '/F1 10 Tf', '50 780 Td'];
  lines.forEach((line, idx) => {
    if (idx > 0) contentLines.push('0 -14 Td');
    contentLines.push(`(${escapePdfText(line)}) Tj`);
  });
  contentLines.push('ET');
  const stream = contentLines.join('\n');

  const objects: string[] = [];
  objects[1] = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  objects[2] = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';
  objects[3] =
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n';
  objects[4] =
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n';
  objects[5] = `5 0 obj\n<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream\nendobj\n`;

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (let i = 1; i <= 5; i += 1) {
    offsets[i] = Buffer.byteLength(pdf, 'utf8');
    pdf += objects[i];
  }

  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((off) => `${String(off).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(pdf, 'utf8');
}

function toPdf(table: NormalizedTable): Buffer {
  const lines: string[] = [];

  lines.push('Investigation Export');
  lines.push(`Rows: ${table.rows.length}`);
  lines.push('');

  if (!table.rows.length || !table.columns.length) {
    lines.push('No records available.');
  } else {
    const maxColWidth = Math.max(
      12,
      Math.floor((PDF_LINE_WIDTH - (table.columns.length - 1) * 3) / table.columns.length),
    );
    const header = table.columns
      .map((c) => truncate(c, maxColWidth).padEnd(maxColWidth, ' '))
      .join(' | ');
    const separator = '-'.repeat(Math.min(PDF_LINE_WIDTH, header.length));
    lines.push(header);
    lines.push(separator);
    table.rows.slice(0, PDF_MAX_ROWS).forEach((row) => {
      const line = table.columns
        .map((column) =>
          truncate(row[column] ?? '', maxColWidth).padEnd(maxColWidth, ' '),
        )
        .join(' | ');
      lines.push(line);
    });
    if (table.rows.length > PDF_MAX_ROWS) {
      lines.push('...');
      lines.push(`Truncated to first ${PDF_MAX_ROWS} rows for PDF export.`);
    }
  }

  return buildSimplePdf(lines);
}

export async function POST(req: NextRequest) {
  try {
    const { format, records, filename } = (await req.json()) as ExportRequestBody;

    if (!format || !['csv', 'xlsx', 'pdf'].includes(format)) {
      return NextResponse.json(
        { error: 'format must be one of: csv, xlsx, pdf' },
        { status: 400 },
      );
    }

    if (!Array.isArray(records)) {
      return NextResponse.json(
        { error: 'records (array) is required' },
        { status: 400 },
      );
    }

    if (records.length > MAX_EXPORT_ROWS) {
      return NextResponse.json(
        {
          error: `Export row limit exceeded. Maximum allowed is ${MAX_EXPORT_ROWS}.`,
        },
        { status: 400 },
      );
    }

    const baseName = sanitizeFilename(filename || 'investigation_export');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const finalName = `${baseName}_${stamp}.${format}`;
    const table = normalizeRecords(records);

    if (format === 'csv') {
      const csv = toCsv(table);
      return new Response(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${finalName}"`,
        },
      });
    }

    if (format === 'xlsx') {
      const worksheet = XLSX.utils.json_to_sheet(table.rows, {
        header: table.columns,
      });
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Data');
      const buf = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
      return new Response(new Uint8Array(buf), {
        status: 200,
        headers: {
          'Content-Type':
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${finalName}"`,
        },
      });
    }

    const pdf = toPdf(table);
    return new Response(new Uint8Array(pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${finalName}"`,
      },
    });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'An unexpected error occurred.';
    console.error('[Export API] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
