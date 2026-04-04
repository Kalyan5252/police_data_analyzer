import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { pgQuery } from '@/lib/postgres';

type CaseSummary = {
  caseId: string;
  title: string;
  updatedAt: string;
  createdAt: string;
  lastMessagePreview: string;
};

export async function GET() {
  try {
    const result = await pgQuery<CaseSummary>(
      `
      SELECT
        c.case_id AS "caseId",
        c.title AS "title",
        to_char(c.updated_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS "updatedAt",
        to_char(c.created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS "createdAt",
        COALESCE(m.content, '') AS "lastMessagePreview"
      FROM case_histories c
      LEFT JOIN LATERAL (
        SELECT content
        FROM chat_messages
        WHERE case_id = c.case_id
        ORDER BY created_at DESC
        LIMIT 1
      ) m ON TRUE
      ORDER BY c.updated_at DESC
      LIMIT 100
      `,
    );

    return NextResponse.json(
      { success: true, cases: result.rows },
      { status: 200 },
    );
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'Failed to fetch case histories.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const incomingTitle =
      body && typeof body.title === 'string' ? body.title.trim() : '';

    const caseId = randomUUID();
    const title = incomingTitle || `Case ${new Date().toLocaleDateString('en-GB')}`;

    await pgQuery(
      `
      INSERT INTO case_histories (case_id, title, created_at, updated_at)
      VALUES ($1, $2, NOW(), NOW())
      `,
      [caseId, title],
    );

    return NextResponse.json(
      {
        success: true,
        case: {
          caseId,
          title,
        },
      },
      { status: 201 },
    );
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'Failed to create case history.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
