import { NextRequest, NextResponse } from 'next/server';
import { getDriver } from '@/lib/neo4j';

export async function POST(req: NextRequest) {
  try {
    const { query } = await req.json();

    if (!query || typeof query !== 'string') {
      return NextResponse.json(
        { error: 'Query string is required.' },
        { status: 400 },
      );
    }

    const driver = getDriver();
    const session = driver.session();

    try {
      // Run the Cypher query from the user input
      const result = await session.run(query);

      const records = result.records.map((record) => {
        const obj: Record<string, unknown> = {};
        (record.keys as string[]).forEach((key) => {
          const value = record.get(key);
          obj[key] = serialize(value);
        });
        return obj;
      });

      return NextResponse.json({
        success: true,
        records,
        summary: {
          resultAvailableAfter:
            result.summary.resultAvailableAfter?.toNumber?.() ?? null,
          counters: result.summary.counters?.updates() ?? {},
        },
      });
    } finally {
      await session.close();
    }
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'An unexpected error occurred.';
    console.error('[Neo4j API] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Recursively serializes Neo4j values (Integers, Nodes, Relationships, etc.)
 * into plain JSON-friendly objects.
 */
function serialize(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  // Neo4j Integer
  if (
    typeof value === 'object' &&
    value !== null &&
    'low' in value &&
    'high' in value
  ) {
    return (value as unknown as { toNumber: () => number }).toNumber();
  }

  // Neo4j Node
  if (
    typeof value === 'object' &&
    value !== null &&
    'labels' in value &&
    'properties' in value
  ) {
    const node = value as {
      labels: string[];
      properties: Record<string, unknown>;
      identity: unknown;
    };
    return {
      _type: 'node',
      labels: node.labels,
      properties: serializeProps(node.properties),
    };
  }

  // Neo4j Relationship
  if (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    'properties' in value &&
    'start' in value &&
    'end' in value
  ) {
    const rel = value as { type: string; properties: Record<string, unknown> };
    return {
      _type: 'relationship',
      relationshipType: rel.type,
      properties: serializeProps(rel.properties),
    };
  }

  // Arrays
  if (Array.isArray(value)) {
    return value.map(serialize);
  }

  return value;
}

function serializeProps(
  props: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(props)) {
    result[key] = serialize(val);
  }
  return result;
}
