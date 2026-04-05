import { NextRequest, NextResponse } from 'next/server';
import { pgQuery } from '@/lib/postgres';

type GraphDebugRow = {
  message_id: string;
  case_id: string;
  role: 'system';
  created_at: string;
  content_preview: string;
  payload: {
    graph?: {
      nodes?: unknown[];
      edges?: unknown[];
      meta?: Record<string, unknown>;
    };
  };
};

export async function GET(req: NextRequest) {
  try {
    const caseId = req.nextUrl.searchParams.get('caseId')?.trim() || '';
    const limitRaw = req.nextUrl.searchParams.get('limit')?.trim() || '5';
    const limitNum = Math.max(1, Math.min(50, Number(limitRaw) || 5));
    const mode = (req.nextUrl.searchParams.get('mode') || 'graph').trim().toLowerCase();

    const whereGraphOnly = `
      role = 'system'
      AND payload ? 'graph'
      AND jsonb_typeof(payload->'graph') = 'object'
      AND COALESCE(jsonb_array_length(payload->'graph'->'nodes'), 0) > 0
    `;

    const whereSourceCandidates = `
      role = 'system'
      AND (
        (payload ? 'graph' AND jsonb_typeof(payload->'graph') = 'object' AND COALESCE(jsonb_array_length(payload->'graph'->'nodes'), 0) > 0)
        OR (payload ? 'records' AND jsonb_typeof(payload->'records') = 'array' AND COALESCE(jsonb_array_length(payload->'records'), 0) > 0)
        OR (payload ? 'cypher' AND length(COALESCE(payload->>'cypher', '')) > 0)
      )
    `;

    const whereAllMessages = `TRUE`;
    const whereClause =
      mode === 'source'
        ? whereSourceCandidates
        : mode === 'all'
          ? whereAllMessages
          : whereGraphOnly;

    const result = caseId
      ? await pgQuery<GraphDebugRow>(
          `
          SELECT
            message_id,
            case_id,
            role,
            created_at::text AS created_at,
            LEFT(content, 200) AS content_preview,
            payload
          FROM chat_messages
          WHERE case_id = $1
            AND ${whereClause}
          ORDER BY created_at DESC
          LIMIT $2
          `,
          [caseId, limitNum],
        )
      : await pgQuery<GraphDebugRow>(
          `
          SELECT
            message_id,
            case_id,
            role,
            created_at::text AS created_at,
            LEFT(content, 200) AS content_preview,
            payload
          FROM chat_messages
          WHERE ${whereClause}
          ORDER BY created_at DESC
          LIMIT $1
          `,
          [limitNum],
        );

    const rows = result.rows.map((row) => {
      const nodes = Array.isArray(row.payload?.graph?.nodes)
        ? row.payload.graph?.nodes
        : [];
      const edges = Array.isArray(row.payload?.graph?.edges)
        ? row.payload.graph?.edges
        : [];
      const records = Array.isArray((row.payload as Record<string, unknown>)?.records)
        ? ((row.payload as Record<string, unknown>).records as unknown[])
        : [];
      const cypher =
        typeof (row.payload as Record<string, unknown>)?.cypher === 'string'
          ? String((row.payload as Record<string, unknown>).cypher)
          : '';
      return {
        messageId: row.message_id,
        caseId: row.case_id,
        role: row.role,
        createdAt: row.created_at,
        contentPreview: row.content_preview,
        hasGraph: nodes.length > 0,
        hasRecords: records.length > 0,
        hasCypher: cypher.trim().length > 0,
        recordsCount: records.length,
        graphMeta: row.payload?.graph?.meta ?? null,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        cypherPreview: cypher ? cypher.slice(0, 200) : '',
        firstNode: nodes.length > 0 ? nodes[0] : null,
      };
    });

    return NextResponse.json(
      {
        success: true,
        filter: {
          caseId: caseId || null,
          limit: limitNum,
          mode,
        },
        count: rows.length,
        rows,
      },
      { status: 200 },
    );
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'Failed to fetch graph debug rows.';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
