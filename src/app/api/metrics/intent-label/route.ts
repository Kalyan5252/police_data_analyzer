import { NextRequest, NextResponse } from 'next/server';
import { withPgClient } from '@/lib/postgres';
import {
  InvestigationIntent,
  IntentReasonTag,
  isInvestigationIntent,
  isIntentReasonTag,
} from '@/lib/investigationIntent';

type LabelBody = {
  messageId?: string;
  trueIntent?: string;
  reasonTag?: string;
  notes?: string;
  reviewedBy?: string;
  predictedIntent?: string;
};

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as LabelBody;
    const messageId = typeof body.messageId === 'string' ? body.messageId.trim() : '';
    if (!messageId) {
      return NextResponse.json({ error: 'messageId is required.' }, { status: 400 });
    }

    const trueIntentRaw = typeof body.trueIntent === 'string' ? body.trueIntent.trim() : '';
    if (!trueIntentRaw || !isInvestigationIntent(trueIntentRaw)) {
      return NextResponse.json({ error: 'trueIntent is invalid.' }, { status: 400 });
    }
    const trueIntent = trueIntentRaw as InvestigationIntent;

    const reasonTagRaw = typeof body.reasonTag === 'string' ? body.reasonTag.trim() : '';
    const reasonTag =
      reasonTagRaw && isIntentReasonTag(reasonTagRaw)
        ? (reasonTagRaw as IntentReasonTag)
        : null;

    const reviewedBy =
      typeof body.reviewedBy === 'string' && body.reviewedBy.trim()
        ? body.reviewedBy.trim().slice(0, 80)
        : 'investigator';
    const notes =
      typeof body.notes === 'string' && body.notes.trim()
        ? body.notes.trim().slice(0, 2000)
        : null;

    const predictedFromBody =
      typeof body.predictedIntent === 'string' && isInvestigationIntent(body.predictedIntent)
        ? body.predictedIntent
        : null;

    const result = await withPgClient(async (client) => {
      await client.query('BEGIN');
      try {
        const messageResult = await client.query<{
          case_id: string;
          predicted_intent: string | null;
          role: string;
        }>(
          `
          SELECT
            case_id,
            payload->>'predictedIntent' AS predicted_intent,
            role
          FROM chat_messages
          WHERE message_id = $1
          LIMIT 1
          `,
          [messageId],
        );

        if ((messageResult.rowCount ?? 0) === 0) {
          await client.query('ROLLBACK');
          return { status: 'not_found' as const };
        }

        const row = messageResult.rows[0];
        if (row.role !== 'system') {
          await client.query('ROLLBACK');
          return { status: 'invalid_role' as const };
        }

        const predictedCandidate = predictedFromBody || row.predicted_intent || 'other';
        const predictedIntent = isInvestigationIntent(predictedCandidate)
          ? predictedCandidate
          : ('other' as InvestigationIntent);

        const upsert = await client.query<{
          message_id: string;
          case_id: string;
          predicted_intent: string;
          true_intent: string;
          reason_tag: string | null;
          notes: string | null;
          reviewed_by: string;
          reviewed_at: string;
        }>(
          `
          INSERT INTO investigation_intent_labels
            (message_id, case_id, predicted_intent, true_intent, reason_tag, notes, reviewed_by, reviewed_at)
          VALUES
            ($1, $2, $3, $4, $5, $6, $7, NOW())
          ON CONFLICT (message_id) DO UPDATE
          SET
            predicted_intent = EXCLUDED.predicted_intent,
            true_intent = EXCLUDED.true_intent,
            reason_tag = EXCLUDED.reason_tag,
            notes = EXCLUDED.notes,
            reviewed_by = EXCLUDED.reviewed_by,
            reviewed_at = NOW()
          RETURNING message_id, case_id, predicted_intent, true_intent, reason_tag, notes, reviewed_by, reviewed_at
          `,
          [
            messageId,
            row.case_id,
            predictedIntent,
            trueIntent,
            reasonTag,
            notes,
            reviewedBy,
          ],
        );

        await client.query('COMMIT');
        return { status: 'ok' as const, label: upsert.rows[0] };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });

    if (result.status === 'not_found') {
      return NextResponse.json({ error: 'Message not found.' }, { status: 404 });
    }
    if (result.status === 'invalid_role') {
      return NextResponse.json(
        { error: 'Only system analysis messages can be labeled.' },
        { status: 400 },
      );
    }

    return NextResponse.json({ success: true, label: result.label }, { status: 200 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to save label.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

