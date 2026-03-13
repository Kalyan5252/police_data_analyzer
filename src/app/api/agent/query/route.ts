import { NextRequest, NextResponse } from 'next/server';
import {
  ConversationTurn,
  InvestigationProgressEvent,
  runInvestigationTurn,
} from '@/lib/agentOrchestrator';

type AgentRequestBody = {
  message?: string;
  stream?: boolean;
  history?: ConversationTurn[];
};

export async function POST(req: NextRequest) {
  try {
    const { message, stream, history } = (await req.json()) as AgentRequestBody;

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
          .slice(-12)
      : [];

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
              const result = await runInvestigationTurn(message, {
                history: normalizedHistory,
                onProgress: async (event: InvestigationProgressEvent) => {
                  writeSse(controller, 'progress', event);
                },
              });

              writeSse(controller, 'final', {
                success: true,
                finalAnswer: result.finalAnswer,
                cypher: result.cypher,
                records: result.records,
                modelResponses: result.modelResponses,
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

    const result = await runInvestigationTurn(message, {
      history: normalizedHistory,
    });

    return NextResponse.json(
      {
        success: true,
        finalAnswer: result.finalAnswer,
        cypher: result.cypher,
        records: result.records,
        modelResponses: result.modelResponses,
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
