import { NextRequest, NextResponse } from 'next/server';
import {
  ConversationTurn,
  InvestigationProgressEvent,
  runInvestigationTurn,
} from '@/lib/agentOrchestrator';
import { pgQuery } from '@/lib/postgres';
import {
  buildAgentCacheKey,
  getOrCreateAgentResult,
} from '@/lib/agentRequestCache';

type AgentRequestBody = {
  message?: string;
  stream?: boolean;
  includeGraph?: boolean;
  history?: ConversationTurn[];
  caseId?: string;
};

function normalizeCacheText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function buildHistoryFingerprint(turns: ConversationTurn[]): string {
  const recent = turns.slice(-8);
  const raw = recent
    .map((t) => `${t.role}:${normalizeCacheText(t.content).slice(0, 200)}`)
    .join('|');
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function dedupeTurns(turns: ConversationTurn[]): ConversationTurn[] {
  const out: ConversationTurn[] = [];
  for (const turn of turns) {
    const content = typeof turn.content === 'string' ? turn.content.trim() : '';
    if (!content) continue;
    const normalized: ConversationTurn = { role: turn.role, content };
    const last = out[out.length - 1];
    if (last && last.role === normalized.role && last.content === normalized.content) {
      continue;
    }
    out.push(normalized);
  }
  return out;
}

async function loadCaseHistory(caseId: string): Promise<ConversationTurn[]> {
  const result = await pgQuery<{ role: string; content: string }>(
    `
    SELECT role, content
    FROM chat_messages
    WHERE case_id = $1
    ORDER BY created_at ASC
    LIMIT 1000
    `,
    [caseId],
  );

  return result.rows
    .map((r: { role: string; content: string }): ConversationTurn => {
      const role: 'user' | 'system' = r.role === 'user' ? 'user' : 'system';
      return {
        role,
        content: r.content ?? '',
      };
    })
    .filter((t: ConversationTurn) => t.content.trim().length > 0);
}

export async function POST(req: NextRequest) {
  try {
    const { message, stream, includeGraph, history, caseId } = (await req.json()) as AgentRequestBody;

    if (!message || typeof message !== 'string') {
      return NextResponse.json(
        { error: 'message (string) is required.' },
        { status: 400 },
      );
    }

    const normalizedHistory = Array.isArray(history)
      ? history
          .filter(
            (turn) =>
              turn &&
              (turn.role === 'user' || turn.role === 'system') &&
              typeof turn.content === 'string',
          )
          .slice(-60)
      : [];

    const dbHistory =
      typeof caseId === 'string' && caseId.trim()
        ? await loadCaseHistory(caseId.trim())
        : [];
    const mergedHistory = dedupeTurns([...dbHistory, ...normalizedHistory]).slice(-60);
    const cacheKey = buildAgentCacheKey({
      caseId: typeof caseId === 'string' ? caseId.trim() : '',
      includeGraph: Boolean(includeGraph),
      message: normalizeCacheText(message),
      contextFingerprint: buildHistoryFingerprint(mergedHistory),
    });

    if (stream) {
      const encoder = new TextEncoder();
      const writeSse = (
        controller: ReadableStreamDefaultController<Uint8Array>,
        event: string,
        payload: unknown,
      ) => {
        controller.enqueue(
          encoder.encode(
            `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`,
          ),
        );
      };

      const rs = new ReadableStream<Uint8Array>({
        start(controller) {
          const run = async () => {
            try {
              const { result, fromCache } = await getOrCreateAgentResult(
                cacheKey,
                () =>
                  runInvestigationTurn(message, {
                    history: mergedHistory,
                    includeGraph: Boolean(includeGraph),
                    onProgress: async (event: InvestigationProgressEvent) => {
                      writeSse(controller, 'progress', event);
                    },
                  }),
                60_000,
              );

              if (fromCache) {
                writeSse(controller, 'progress', {
                  stage: 'completed',
                  message: 'Served from 1-minute response cache.',
                  meta: { cacheHit: true },
                } satisfies InvestigationProgressEvent);
              }

              writeSse(controller, 'final', {
                success: true,
                finalAnswer: result.finalAnswer,
                cypher: result.cypher,
                records: result.records,
                graph: result.graph,
                modelResponses: result.modelResponses,
                candidateQueries: result.candidateQueries,
                queryEvaluation: result.queryEvaluation,
                predictedIntent: result.predictedIntent,
                intentConfidence: result.intentConfidence,
                strategyUsed: result.strategyUsed,
                cacheHit: fromCache,
              });
            } catch (err: unknown) {
              const errMessage =
                err instanceof Error
                  ? err.message
                  : 'An unexpected error occurred.';
              writeSse(controller, 'error', { error: errMessage });
            } finally {
              controller.close();
            }
          };
          void run();
        },
      });

      return new Response(rs, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        },
      });
    }

    const { result, fromCache } = await getOrCreateAgentResult(
      cacheKey,
      () =>
        runInvestigationTurn(message, {
          history: mergedHistory,
          includeGraph: Boolean(includeGraph),
        }),
      60_000,
    );

    return NextResponse.json(
      {
        success: true,
        finalAnswer: result.finalAnswer,
        cypher: result.cypher,
        records: result.records,
        graph: result.graph,
        modelResponses: result.modelResponses,
        candidateQueries: result.candidateQueries,
        queryEvaluation: result.queryEvaluation,
        predictedIntent: result.predictedIntent,
        intentConfidence: result.intentConfidence,
        strategyUsed: result.strategyUsed,
        cacheHit: fromCache,
      },
      { status: 200 },
    );
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'An unexpected error occurred.';
    console.error('[Agent API] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
