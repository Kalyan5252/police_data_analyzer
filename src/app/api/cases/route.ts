import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { getDriver } from '@/lib/neo4j';

type CaseSummary = {
  caseId: string;
  title: string;
  updatedAt: string;
  createdAt: string;
  lastMessagePreview: string;
};

function toNative(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (
    typeof value === 'object' &&
    value !== null &&
    'toNumber' in value &&
    typeof (value as { toNumber?: unknown }).toNumber === 'function'
  ) {
    return (value as { toNumber: () => number }).toNumber();
  }

  if (
    typeof value === 'object' &&
    value !== null &&
    'toString' in value &&
    typeof (value as { toString?: unknown }).toString === 'function'
  ) {
    return (value as { toString: () => string }).toString();
  }

  return value;
}

export async function GET() {
  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(
      `
      MATCH (c:CaseHistory)
      OPTIONAL MATCH (c)-[:HAS_MESSAGE]->(m:ChatMessage)
      WITH c, m
      ORDER BY m.created_at DESC
      WITH c, collect(m)[0] AS latest
      RETURN
        c.case_id AS caseId,
        c.title AS title,
        toString(c.updated_at) AS updatedAt,
        toString(c.created_at) AS createdAt,
        coalesce(latest.content, '') AS lastMessagePreview
      ORDER BY c.updated_at DESC
      LIMIT 100
      `,
    );

    const cases: CaseSummary[] = result.records.map((record) => ({
      caseId: String(toNative(record.get('caseId')) ?? ''),
      title: String(toNative(record.get('title')) ?? 'Untitled Case'),
      updatedAt: String(toNative(record.get('updatedAt')) ?? ''),
      createdAt: String(toNative(record.get('createdAt')) ?? ''),
      lastMessagePreview: String(toNative(record.get('lastMessagePreview')) ?? ''),
    }));

    return NextResponse.json({ success: true, cases }, { status: 200 });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'Failed to fetch case histories.';
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await session.close();
  }
}

export async function POST(req: NextRequest) {
  const driver = getDriver();
  const session = driver.session();

  try {
    const body = await req.json().catch(() => ({}));
    const incomingTitle =
      body && typeof body.title === 'string' ? body.title.trim() : '';

    const caseId = randomUUID();
    const title = incomingTitle || `Case ${new Date().toLocaleDateString('en-GB')}`;

    await session.run(
      `
      CREATE (c:CaseHistory {
        case_id: $caseId,
        title: $title,
        created_at: datetime(),
        updated_at: datetime()
      })
      RETURN c.case_id AS caseId, c.title AS title
      `,
      { caseId, title },
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
  } finally {
    await session.close();
  }
}
