import { NextRequest, NextResponse } from 'next/server';
import { getDriver } from '@/lib/neo4j';

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

  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(
      `
      MATCH (c:CaseHistory {case_id: $caseId})
      SET c.title = $title,
          c.updated_at = datetime()
      RETURN c.case_id AS caseId, c.title AS title
      `,
      { caseId, title },
    );

    if (result.records.length === 0) {
      return NextResponse.json({ error: 'Case not found.' }, { status: 404 });
    }

    return NextResponse.json(
      {
        success: true,
        case: {
          caseId: String(result.records[0].get('caseId')),
          title: String(result.records[0].get('title')),
        },
      },
      { status: 200 },
    );
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'Failed to rename conversation.';
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await session.close();
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

  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(
      `
      MATCH (c:CaseHistory {case_id: $caseId})
      OPTIONAL MATCH (c)-[:HAS_MESSAGE]->(m:ChatMessage)
      WITH c, collect(m) AS messages
      FOREACH (msg IN messages | DETACH DELETE msg)
      DETACH DELETE c
      RETURN $caseId AS caseId
      `,
      { caseId },
    );

    if (result.records.length === 0) {
      return NextResponse.json({ error: 'Case not found.' }, { status: 404 });
    }

    return NextResponse.json({ success: true, caseId }, { status: 200 });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'Failed to delete conversation.';
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await session.close();
  }
}
