import { NextRequest, NextResponse } from 'next/server';
import { pgQuery } from '@/lib/postgres';

type CaseMessageRow = {
  id: number;
  message_id: string;
  case_id: string;
  role: 'user' | 'system';
  content: string;
  timestamp: string;
  created_at_iso: string;
  created_at: string;
  payload: Record<string, unknown>;
};

export async function GET(req: NextRequest) {
  try {
    const caseId = req.nextUrl.searchParams.get('caseId')?.trim() || '';
    if (!caseId) {
      return NextResponse.json(
        { success: false, error: 'caseId is required.' },
        { status: 400 },
      );
    }

    const limitRaw = req.nextUrl.searchParams.get('limit')?.trim() || '500';
    const limitNum = Math.max(1, Math.min(5000, Number(limitRaw) || 500));

    const result = await pgQuery<CaseMessageRow>(
      `
      SELECT
        id,
        message_id,
        case_id,
        role,
        content,
        timestamp,
        created_at_iso,
        created_at::text AS created_at,
        payload
      FROM chat_messages
      WHERE case_id = $1
      ORDER BY created_at ASC
      LIMIT $2
      `,
      [caseId, limitNum],
    );

    const rows = result.rows.map((row) => ({
      id: row.id,
      messageId: row.message_id,
      caseId: row.case_id,
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
      createdAtIso: row.created_at_iso,
      createdAt: row.created_at,
      payload: row.payload ?? {},
      hasGraph:
        Boolean(row.payload?.graph) &&
        Array.isArray((row.payload?.graph as { nodes?: unknown[] })?.nodes) &&
        ((row.payload?.graph as { nodes?: unknown[] })?.nodes?.length ?? 0) > 0,
      hasRecords:
        Array.isArray((row.payload as { records?: unknown[] })?.records) &&
        (((row.payload as { records?: unknown[] })?.records?.length ?? 0) > 0),
      hasCypher:
        typeof (row.payload as { cypher?: unknown })?.cypher === 'string' &&
        String((row.payload as { cypher?: unknown }).cypher).trim().length > 0,
    }));

    return NextResponse.json(
      {
        success: true,
        filter: { caseId, limit: limitNum },
        count: rows.length,
        rows,
      },
      { status: 200 },
    );
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'Failed to fetch case messages.';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

