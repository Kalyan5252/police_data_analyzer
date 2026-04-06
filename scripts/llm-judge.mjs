#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const CASES_PATH = process.env.CASES || 'tests/llm-judge/cases.sample.json';
const CASE_ID = process.env.CASE_ID || '';
const JUDGE_MODEL = process.env.JUDGE_MODEL || 'gpt-5-mini';
const OUT_DIR = process.env.OUT_DIR || 'tests/llm-judge/reports';
const INCLUDE_GRAPH = process.env.INCLUDE_GRAPH === '1';
const PASS_THRESHOLD = Number(process.env.PASS_THRESHOLD || 60);

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is required for GPT-5 judging.');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function readCases(filePath) {
  const abs = path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(abs, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Cases file must be an array: ${abs}`);
  }
  return parsed;
}

async function runAgentQuery(message, history = []) {
  const body = {
    message,
    stream: false,
    includeGraph: INCLUDE_GRAPH,
    history,
  };
  if (CASE_ID) body.caseId = CASE_ID;

  const res = await fetch(`${BASE_URL}/api/agent/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok || json?.error || json?.success === false) {
    throw new Error(`Agent query failed: ${json?.error || res.statusText}`);
  }
  return json;
}

function extractTextFromResponse(response) {
  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }

  if (Array.isArray(response.output)) {
    const parts = [];
    for (const item of response.output) {
      if (!item || !Array.isArray(item.content)) continue;
      for (const c of item.content) {
        if (c?.type === 'output_text' && typeof c.text === 'string') {
          parts.push(c.text);
        }
      }
    }
    if (parts.length) return parts.join('\n').trim();
  }

  return '';
}

function parseJudgeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error('Judge output is not valid JSON.');
  }
}

function buildJudgePrompt({ query, cypher, records, finalAnswer, modelResponse }) {
  const recordsSlice = Array.isArray(records)
    ? JSON.stringify(records.slice(0, 20), null, 2)
    : '[]';

  return `You are a strict LLM judge for investigative graph-analysis reasoning quality.
Score the candidate response from one model.

Evaluation rubric (0-5 each):
1) factual_grounding: no claims beyond records
2) schema_reasoning: uses graph relations correctly
3) query_alignment: answer aligns with user query intent
4) completeness: covers key entities/time/relations needed
5) clarity_actionability: clear, concise, useful for investigator

Also provide:
- errors: short list of concrete mistakes
- strengths: short list of concrete strengths
- overall_score_100: integer 0-100

Return STRICT JSON with this shape:
{
  "scores": {
    "factual_grounding": number,
    "schema_reasoning": number,
    "query_alignment": number,
    "completeness": number,
    "clarity_actionability": number
  },
  "overall_score_100": number,
  "errors": string[],
  "strengths": string[],
  "rationale": string
}

User query:
${query}

Cypher executed:
${cypher || 'N/A'}

Raw records (slice):
${recordsSlice}

Final synthesized answer:
${finalAnswer || 'N/A'}

Candidate model response to judge:
Provider: ${modelResponse.provider}
Model: ${modelResponse.model}
Content:
${modelResponse.content}`;
}

async function judgeModelResponse(context) {
  const prompt = buildJudgePrompt(context);
  const response = await openai.responses.create({
    model: JUDGE_MODEL,
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: 'You are an uncompromising evaluator. Output only valid JSON matching the requested schema.'
          }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: prompt
          }
        ]
      }
    ]
  });

  const text = extractTextFromResponse(response);
  const parsed = parseJudgeJson(text);
  const scores = parsed?.scores || {};
  const s1 = Number(scores.factual_grounding || 0);
  const s2 = Number(scores.schema_reasoning || 0);
  const s3 = Number(scores.query_alignment || 0);
  const s4 = Number(scores.completeness || 0);
  const s5 = Number(scores.clarity_actionability || 0);
  const fallbackOverall = Math.round(((s1 + s2 + s3 + s4 + s5) / 25) * 100);
  const overallRaw = Number(parsed?.overall_score_100);
  const overall = Number.isFinite(overallRaw) ? Math.max(0, Math.min(100, Math.round(overallRaw))) : fallbackOverall;
  const verdict = overall >= PASS_THRESHOLD ? 'pass' : 'fail';
  return {
    ...parsed,
    overall_score_100: overall,
    verdict,
  };
}

function avg(nums) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main() {
  const cases = readCases(CASES_PATH);
  console.log(`Running LLM-as-judge on ${cases.length} case(s) via ${BASE_URL}`);
  console.log(`Judge model: ${JUDGE_MODEL} | pass threshold: ${PASS_THRESHOLD}`);

  const results = [];

  for (const [index, tc] of cases.entries()) {
    const name = tc.name || `Case ${index + 1}`;
    console.log(`\n[${index + 1}/${cases.length}] ${name}`);

    const agent = await runAgentQuery(tc.message, Array.isArray(tc.history) ? tc.history : []);
    const modelResponses = Array.isArray(agent.modelResponses) ? agent.modelResponses : [];

    const judged = [];
    for (const mr of modelResponses) {
      if (!mr?.provider || !mr?.model || typeof mr?.content !== 'string') continue;
      const judgment = await judgeModelResponse({
        query: tc.message,
        cypher: agent.cypher,
        records: agent.records,
        finalAnswer: agent.finalAnswer,
        modelResponse: mr,
      });
      judged.push({
        provider: mr.provider,
        model: mr.model,
        judgment,
      });
      const topError = Array.isArray(judgment.errors) && judgment.errors.length ? ` | top issue: ${judgment.errors[0]}` : '';
      console.log(`  - Judged ${mr.provider}/${mr.model}: ${judgment.overall_score_100} (${judgment.verdict})${topError}`);
    }

    results.push({
      caseName: name,
      query: tc.message,
      cypher: agent.cypher,
      judged,
    });
  }

  const flat = results.flatMap((r) => r.judged.map((j) => ({
    caseName: r.caseName,
    provider: j.provider,
    model: j.model,
    overall: Number(j.judgment?.overall_score_100 || 0),
    verdict: j.judgment?.verdict || 'fail',
    scores: j.judgment?.scores || {},
  })));

  const byModel = new Map();
  for (const row of flat) {
    const key = `${row.provider}/${row.model}`;
    if (!byModel.has(key)) byModel.set(key, []);
    byModel.get(key).push(row);
  }

  const summary = [];
  for (const [modelKey, rows] of byModel.entries()) {
    summary.push({
      model: modelKey,
      n: rows.length,
      avg_overall_100: Number(avg(rows.map((r) => r.overall)).toFixed(2)),
      pass_rate: Number((rows.filter((r) => r.verdict === 'pass').length / Math.max(rows.length, 1)).toFixed(4)),
      avg_factual_grounding: Number(avg(rows.map((r) => Number(r.scores.factual_grounding || 0))).toFixed(3)),
      avg_schema_reasoning: Number(avg(rows.map((r) => Number(r.scores.schema_reasoning || 0))).toFixed(3)),
      avg_query_alignment: Number(avg(rows.map((r) => Number(r.scores.query_alignment || 0))).toFixed(3)),
      avg_completeness: Number(avg(rows.map((r) => Number(r.scores.completeness || 0))).toFixed(3)),
      avg_clarity_actionability: Number(avg(rows.map((r) => Number(r.scores.clarity_actionability || 0))).toFixed(3)),
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    judgeModel: JUDGE_MODEL,
    baseUrl: BASE_URL,
    casesFile: CASES_PATH,
    caseId: CASE_ID || null,
    summary,
    results,
  };

  fs.mkdirSync(path.resolve(process.cwd(), OUT_DIR), { recursive: true });
  const outJson = path.resolve(process.cwd(), OUT_DIR, `llm-judge-${stamp()}.json`);
  fs.writeFileSync(outJson, JSON.stringify(report, null, 2));

  const lines = [];
  lines.push('# LLM-as-Judge Report');
  lines.push('');
  lines.push(`- Judge model: ${JUDGE_MODEL}`);
  lines.push(`- Cases: ${cases.length}`);
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push('');
  lines.push('## Model Summary');
  lines.push('');
  lines.push('| Model | N | Avg Overall (0-100) | Pass Rate | Factual | Schema | Alignment | Completeness | Clarity |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const s of summary) {
    lines.push(`| ${s.model} | ${s.n} | ${s.avg_overall_100} | ${s.pass_rate} | ${s.avg_factual_grounding} | ${s.avg_schema_reasoning} | ${s.avg_query_alignment} | ${s.avg_completeness} | ${s.avg_clarity_actionability} |`);
  }

  const outMd = outJson.replace(/\.json$/, '.md');
  fs.writeFileSync(outMd, `${lines.join('\n')}\n`);

  console.log(`\nSaved report JSON: ${outJson}`);
  console.log(`Saved report MD:   ${outMd}`);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exit(1);
});
