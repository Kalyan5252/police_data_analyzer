import { NextRequest, NextResponse } from 'next/server';
import { pgQuery, withPgClient } from '@/lib/postgres';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const { caseId } = await params;
  if (!caseId) {
    return NextResponse.json({ error: 'caseId is required.' }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const title =
    body && typeof body.title === 'string' ? body.title.trim().slice(0, 120) : '';

  if (!title) {
    return NextResponse.json({ error: 'title is required.' }, { status: 400 });
  }

  try {
    const result = await pgQuery<{ caseId: string; title: string }>(
      `
      UPDATE case_histories
      SET title = $2,
          updated_at = NOW()
      WHERE case_id = $1
      RETURNING case_id AS "caseId", title
      `,
      [caseId, title],
    );

    if (result.rowCount === 0) {
      return NextResponse.json({ error: 'Case not found.' }, { status: 404 });
    }

    return NextResponse.json(
      {
        success: true,
        case: result.rows[0],
      },
      { status: 200 },
    );
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'Failed to rename conversation.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const { caseId } = await params;
  if (!caseId) {
    return NextResponse.json({ error: 'caseId is required.' }, { status: 400 });
  }

  try {
    const deleted = await withPgClient(async (client) => {
      await client.query('BEGIN');
      try {
        const result = await client.query(
          'DELETE FROM case_histories WHERE case_id = $1 RETURNING case_id',
          [caseId],
        );
        await client.query('COMMIT');
        return result.rowCount ?? 0;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });

    if (deleted === 0) {
      return NextResponse.json({ error: 'Case not found.' }, { status: 404 });
    }

    return NextResponse.json({ success: true, caseId }, { status: 200 });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'Failed to delete conversation.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
