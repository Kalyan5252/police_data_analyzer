import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getDriver } from '@/lib/neo4j';

type StoredMessage = {
  id: string;
  role: 'user' | 'system';
  content: string;
  timestamp: string;
  createdAt: string;
  records?: Record<string, unknown>[];
  cypher?: string;
  modelResponses?: unknown[];
  error?: boolean;
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

  return value;
}

function parsePayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function GET(
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
      MATCH (c:CaseHistory {case_id: $caseId})-[:HAS_MESSAGE]->(m:ChatMessage)
      RETURN m
      ORDER BY m.created_at ASC
      LIMIT 2000
      `,
      { caseId },
    );

    const messages: StoredMessage[] = result.records.map((record) => {
      const node = record.get('m') as {
        properties: Record<string, unknown>;
      };
      const props = node.properties;
      const payload = parsePayload(toNative(props.payload));

      return {
        id: String(toNative(props.message_id) ?? ''),
        role:
          String(toNative(props.role)) === 'user'
            ? 'user'
            : 'system',
        content: String(toNative(props.content) ?? ''),
        timestamp: String(toNative(props.timestamp) ?? ''),
        createdAt: String(toNative(props.created_at_iso) ?? ''),
        records: Array.isArray(payload.records)
          ? (payload.records as Record<string, unknown>[])
          : undefined,
        cypher:
          typeof payload.cypher === 'string' ? (payload.cypher as string) : undefined,
        modelResponses: Array.isArray(payload.modelResponses)
          ? payload.modelResponses
          : undefined,
        error: Boolean(payload.error),
      };
    });

    return NextResponse.json({ success: true, messages }, { status: 200 });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'Failed to fetch case messages.';
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await session.close();
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
  const payload = JSON.stringify({
    records: Array.isArray(body.records) ? body.records : undefined,
    cypher: typeof body.cypher === 'string' ? body.cypher : undefined,
    modelResponses: Array.isArray(body.modelResponses)
      ? body.modelResponses
      : undefined,
    error: Boolean(body.error),
  });

  const driver = getDriver();
  const session = driver.session();

  try {
    const maybeTitle =
      role === 'user' ? content.replace(/\s+/g, ' ').trim().slice(0, 72) : '';

    await session.run(
      `
      MATCH (c:CaseHistory {case_id: $caseId})
      CREATE (m:ChatMessage {
        message_id: $messageId,
        role: $role,
        content: $content,
        timestamp: $timestamp,
        created_at_iso: $createdAt,
        created_at: datetime($createdAt),
        payload: $payload
      })
      CREATE (c)-[:HAS_MESSAGE]->(m)
      SET c.updated_at = datetime()
      SET c.title = CASE
        WHEN c.title STARTS WITH 'Case ' AND $maybeTitle <> '' THEN $maybeTitle
        ELSE c.title
      END
      RETURN m.message_id AS messageId
      `,
      {
        caseId,
        messageId,
        role,
        content,
        timestamp,
        createdAt,
        payload,
        maybeTitle,
      },
    );

    return NextResponse.json({ success: true, messageId }, { status: 201 });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'Failed to persist chat message.';
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await session.close();
  }
}
