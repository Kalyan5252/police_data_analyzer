import { INVESTIGATION_INTENTS, InvestigationIntent } from '@/lib/investigationIntent';

export type MatrixCell = {
  trueIntent: InvestigationIntent;
  predictedIntent: InvestigationIntent;
  count: number;
};

export type IntentStat = {
  intent: InvestigationIntent;
  support: number;
  predictedCount: number;
  truePositive: number;
  precision: number;
  recall: number;
  f1: number;
};

export type ConfusionMatrixResult = {
  labels: InvestigationIntent[];
  matrix: MatrixCell[];
  stats: IntentStat[];
  macro: {
    precision: number;
    recall: number;
    f1: number;
  };
  micro: {
    precision: number;
    recall: number;
    f1: number;
  };
  totalLabeled: number;
};

function safeDiv(n: number, d: number): number {
  if (!d) return 0;
  return n / d;
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

export function computeConfusionMatrix(
  rows: Array<{ trueIntent: InvestigationIntent; predictedIntent: InvestigationIntent; count: number }>,
): ConfusionMatrixResult {
  const labels = [...INVESTIGATION_INTENTS];
  const cellMap = new Map<string, number>();
  let totalLabeled = 0;

  for (const row of rows) {
    const key = `${row.trueIntent}::${row.predictedIntent}`;
    const next = (cellMap.get(key) ?? 0) + row.count;
    cellMap.set(key, next);
    totalLabeled += row.count;
  }

  const matrix: MatrixCell[] = [];
  for (const t of labels) {
    for (const p of labels) {
      matrix.push({
        trueIntent: t,
        predictedIntent: p,
        count: cellMap.get(`${t}::${p}`) ?? 0,
      });
    }
  }

  const stats: IntentStat[] = labels.map((intent) => {
    const tp = cellMap.get(`${intent}::${intent}`) ?? 0;
    let support = 0;
    let predictedCount = 0;
    for (const other of labels) {
      support += cellMap.get(`${intent}::${other}`) ?? 0;
      predictedCount += cellMap.get(`${other}::${intent}`) ?? 0;
    }
    const precision = safeDiv(tp, predictedCount);
    const recall = safeDiv(tp, support);
    const f1 = safeDiv(2 * precision * recall, precision + recall);
    return {
      intent,
      support,
      predictedCount,
      truePositive: tp,
      precision: round4(precision),
      recall: round4(recall),
      f1: round4(f1),
    };
  });

  const macroPrecision =
    stats.reduce((sum, s) => sum + s.precision, 0) / Math.max(stats.length, 1);
  const macroRecall =
    stats.reduce((sum, s) => sum + s.recall, 0) / Math.max(stats.length, 1);
  const macroF1 = stats.reduce((sum, s) => sum + s.f1, 0) / Math.max(stats.length, 1);

  const totalTp = stats.reduce((sum, s) => sum + s.truePositive, 0);
  const totalPredicted = stats.reduce((sum, s) => sum + s.predictedCount, 0);
  const totalSupport = stats.reduce((sum, s) => sum + s.support, 0);
  const microPrecision = safeDiv(totalTp, totalPredicted);
  const microRecall = safeDiv(totalTp, totalSupport);
  const microF1 = safeDiv(2 * microPrecision * microRecall, microPrecision + microRecall);

  return {
    labels,
    matrix,
    stats,
    macro: {
      precision: round4(macroPrecision),
      recall: round4(macroRecall),
      f1: round4(macroF1),
    },
    micro: {
      precision: round4(microPrecision),
      recall: round4(microRecall),
      f1: round4(microF1),
    },
    totalLabeled,
  };
}

