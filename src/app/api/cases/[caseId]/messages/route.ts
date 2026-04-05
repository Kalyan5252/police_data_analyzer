import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { pgQuery, withPgClient } from '@/lib/postgres';
import { GraphPayload } from '@/lib/graphPayload';

type StoredMessage = {
  id: string;
  role: 'user' | 'system';
  content: string;
  timestamp: string;
  createdAt: string;
  records?: Record<string, unknown>[];
  graph?: GraphPayload;
  cypher?: string;
  candidateQueries?: string[];
  queryEvaluation?: string;
  modelResponses?: unknown[];
  error?: boolean;
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const { caseId } = await params;
  if (!caseId) {
    return NextResponse.json({ error: 'caseId is required.' }, { status: 400 });
  }

  try {
    const result = await pgQuery<{
      id: string;
      role: 'user' | 'system';
      content: string;
      timestamp: string;
      createdAt: string;
      payload: {
        records?: Record<string, unknown>[];
        graph?: GraphPayload;
        cypher?: string;
        candidateQueries?: string[];
        queryEvaluation?: string;
        modelResponses?: unknown[];
        error?: boolean;
      };
    }>(
      `
      SELECT
        message_id AS id,
        role,
        content,
        timestamp,
        created_at_iso AS "createdAt",
        payload
      FROM chat_messages
      WHERE case_id = $1
      ORDER BY created_at ASC
      LIMIT 3000
      `,
      [caseId],
    );

    const messages: StoredMessage[] = result.rows.map((row: {
      id: string;
      role: 'user' | 'system';
      content: string;
      timestamp: string;
      createdAt: string;
      payload: {
        records?: Record<string, unknown>[];
        graph?: GraphPayload;
        cypher?: string;
        candidateQueries?: string[];
        queryEvaluation?: string;
        modelResponses?: unknown[];
        error?: boolean;
      };
    }) => ({
      id: row.id,
      role: row.role === 'user' ? 'user' : 'system',
      content: row.content,
      timestamp: row.timestamp,
      createdAt: row.createdAt,
      records: Array.isArray(row.payload?.records)
        ? (row.payload.records as Record<string, unknown>[])
        : undefined,
      graph:
        row.payload?.graph && typeof row.payload.graph === 'object'
          ? (row.payload.graph as GraphPayload)
          : undefined,
      cypher: typeof row.payload?.cypher === 'string' ? row.payload.cypher : undefined,
      candidateQueries: Array.isArray(row.payload?.candidateQueries)
        ? (row.payload.candidateQueries as string[])
        : undefined,
      queryEvaluation:
        typeof row.payload?.queryEvaluation === 'string'
          ? row.payload.queryEvaluation
          : undefined,
      modelResponses: Array.isArray(row.payload?.modelResponses)
        ? row.payload.modelResponses
        : undefined,
      error: Boolean(row.payload?.error),
    }));

    return NextResponse.json({ success: true, messages }, { status: 200 });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'Failed to fetch case messages.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const { caseId } = await params;
  if (!caseId) {
    return NextResponse.json({ error: 'caseId is required.' }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'message payload is required.' }, { status: 400 });
  }

  const role = body.role === 'user' ? 'user' : 'system';
  const content = typeof body.content === 'string' ? body.content : '';
  const timestamp = typeof body.timestamp === 'string' ? body.timestamp : '';
  const createdAt =
    typeof body.createdAt === 'string' && body.createdAt
      ? body.createdAt
      : new Date().toISOString();

  if (!content.trim()) {
    return NextResponse.json({ error: 'content is required.' }, { status: 400 });
  }

  const messageId =
    typeof body.id === 'string' && body.id.trim() ? body.id : randomUUID();
  const payload = {
    records: Array.isArray(body.records) ? body.records : undefined,
    graph:
      body.graph && typeof body.graph === 'object'
        ? (body.graph as GraphPayload)
        : undefined,
    cypher: typeof body.cypher === 'string' ? body.cypher : undefined,
    candidateQueries: Array.isArray(body.candidateQueries)
      ? body.candidateQueries.filter((v: unknown) => typeof v === 'string')
      : undefined,
    queryEvaluation:
      typeof body.queryEvaluation === 'string' ? body.queryEvaluation : undefined,
    modelResponses: Array.isArray(body.modelResponses)
      ? body.modelResponses
      : undefined,
    error: Boolean(body.error),
  };

  try {
    const maybeTitle =
      role === 'user' ? content.replace(/\s+/g, ' ').trim().slice(0, 72) : '';

    const inserted = await withPgClient(async (client) => {
      await client.query('BEGIN');
      try {
        const exists = await client.query(
          'SELECT case_id FROM case_histories WHERE case_id = $1 LIMIT 1',
          [caseId],
        );
        if ((exists.rowCount ?? 0) === 0) {
          await client.query('ROLLBACK');
          return { notFound: true } as const;
        }

        await client.query(
          `
          INSERT INTO chat_messages
            (message_id, case_id, role, content, timestamp, created_at_iso, created_at, payload)
          VALUES
            ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::jsonb)
          ON CONFLICT (message_id) DO NOTHING
          `,
          [
            messageId,
            caseId,
            role,
            content,
            timestamp,
            createdAt,
            createdAt,
            JSON.stringify(payload),
          ],
        );

        await client.query(
          `
          UPDATE case_histories
          SET
            updated_at = NOW(),
            title = CASE
              WHEN title LIKE 'Case %' AND $2 <> '' THEN $2
              ELSE title
            END
          WHERE case_id = $1
          `,
          [caseId, maybeTitle],
        );

        await client.query('COMMIT');
        return { notFound: false } as const;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });

    if (inserted.notFound) {
      return NextResponse.json({ error: 'Case not found.' }, { status: 404 });
    }

    return NextResponse.json({ success: true, messageId }, { status: 201 });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'Failed to persist chat message.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
