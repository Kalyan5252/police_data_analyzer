import { NextRequest, NextResponse } from 'next/server';
import { getDriver } from '@/lib/neo4j';
import { normalizeTemporalFields } from '@/lib/timeNormalization';
import {
  extractGraphFromRecords,
  serializeNeo4jRecord,
} from '@/lib/graphPayload';

export async function POST(req: NextRequest) {
  try {
    const { query, includeGraph } = await req.json();

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
        const obj = serializeNeo4jRecord({
          keys: record.keys as string[],
          get: (key: string) => record.get(key),
        });
        return normalizeTemporalFields(obj as Record<string, unknown>);
      });
      const graph = includeGraph ? extractGraphFromRecords(records) : undefined;

      return NextResponse.json({
        success: true,
        records,
        graph,
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
