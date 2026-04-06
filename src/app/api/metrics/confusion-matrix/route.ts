import { NextRequest, NextResponse } from 'next/server';
import { pgQuery } from '@/lib/postgres';
import { computeConfusionMatrix } from '@/lib/confusionMatrix';
import { isInvestigationIntent, InvestigationIntent } from '@/lib/investigationIntent';

type MatrixRow = {
  trueIntent: string;
  predictedIntent: string;
  count: number;
};

type TopConfusion = {
  trueIntent: InvestigationIntent;
  predictedIntent: InvestigationIntent;
  count: number;
};

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const caseId = url.searchParams.get('caseId')?.trim() || '';
    const reviewer = url.searchParams.get('reviewer')?.trim() || '';
    const from = url.searchParams.get('from')?.trim() || '';
    const to = url.searchParams.get('to')?.trim() || '';

    const filters: string[] = [];
    const filterValues: unknown[] = [];
    if (caseId) {
      filterValues.push(caseId);
      filters.push(`l.case_id = $${filterValues.length}`);
    }
    if (reviewer) {
      filterValues.push(reviewer);
      filters.push(`l.reviewed_by = $${filterValues.length}`);
    }
    if (from) {
      filterValues.push(from);
      filters.push(`l.reviewed_at >= $${filterValues.length}::timestamptz`);
    }
    if (to) {
      filterValues.push(to);
      filters.push(`l.reviewed_at <= $${filterValues.length}::timestamptz`);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const grouped = await pgQuery<MatrixRow>(
      `
      SELECT
        l.true_intent AS "trueIntent",
        l.predicted_intent AS "predictedIntent",
        COUNT(*)::int AS "count"
      FROM investigation_intent_labels l
      ${whereClause}
      GROUP BY l.true_intent, l.predicted_intent
      `,
      filterValues,
    );

    const rows = grouped.rows
      .filter((r) => isInvestigationIntent(r.trueIntent) && isInvestigationIntent(r.predictedIntent))
      .map((r) => ({
        trueIntent: r.trueIntent as InvestigationIntent,
        predictedIntent: r.predictedIntent as InvestigationIntent,
        count: Number(r.count) || 0,
      }));

    const matrix = computeConfusionMatrix(rows);

    const topConfusions: TopConfusion[] = [...matrix.matrix]
      .filter((c) => c.trueIntent !== c.predictedIntent && c.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 12)
      .map((c) => ({
        trueIntent: c.trueIntent,
        predictedIntent: c.predictedIntent,
        count: c.count,
      }));

    const unresolvedFilters: string[] = ['m.role = \'system\'', 'm.payload ? \'predictedIntent\''];
    const unresolvedValues: unknown[] = [];
    if (caseId) {
      unresolvedValues.push(caseId);
      unresolvedFilters.push(`m.case_id = $${unresolvedValues.length}`);
    }
    if (from) {
      unresolvedValues.push(from);
      unresolvedFilters.push(`m.created_at >= $${unresolvedValues.length}::timestamptz`);
    }
    if (to) {
      unresolvedValues.push(to);
      unresolvedFilters.push(`m.created_at <= $${unresolvedValues.length}::timestamptz`);
    }

    const unresolvedWhere = unresolvedFilters.join(' AND ');
    const unresolved = await pgQuery<{ count: number }>(
      `
      SELECT COUNT(*)::int AS count
      FROM chat_messages m
      LEFT JOIN investigation_intent_labels l
        ON l.message_id = m.message_id
      WHERE ${unresolvedWhere}
        AND l.message_id IS NULL
      `,
      unresolvedValues,
    );

    return NextResponse.json(
      {
        success: true,
        filter: {
          caseId: caseId || undefined,
          reviewer: reviewer || undefined,
          from: from || undefined,
          to: to || undefined,
        },
        ...matrix,
        topConfusions,
        unresolvedLabelCount: Number(unresolved.rows[0]?.count ?? 0),
      },
      { status: 200 },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to compute confusion matrix.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

