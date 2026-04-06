#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
const casesPath = process.env.CASES || 'tests/query-validation/cases.sample.json';
const caseId = process.env.CASE_ID || '';
const includeGraph = process.env.INCLUDE_GRAPH === '1';

function loadCases(filePath) {
  const abs = path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(abs, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Cases file must be an array: ${abs}`);
  }
  return parsed;
}

function flattenCypherPayload(responseJson) {
  const parts = [];
  if (typeof responseJson.cypher === 'string') {
    parts.push(responseJson.cypher);
  }
  if (Array.isArray(responseJson.candidateQueries)) {
    for (const q of responseJson.candidateQueries) {
      if (typeof q === 'string') {
        parts.push(q);
      } else if (q && typeof q.cypher === 'string') {
        parts.push(q.cypher);
      }
    }
  }
  return parts.join('\n\n---\n\n');
}

function containsAny(haystack, needles = []) {
  if (!needles.length) return true;
  return needles.some((n) => haystack.includes(n));
}

function containsAll(haystack, needles = []) {
  if (!needles.length) return true;
  return needles.every((n) => haystack.includes(n));
}

async function runCase(testCase) {
  const body = {
    message: testCase.message,
    stream: false,
    includeGraph,
    history: [],
  };
  if (caseId) body.caseId = caseId;

  let res;
  try {
    res = await fetch(`${baseUrl}/api/agent/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `network_error: ${message}. Is dev server running at ${baseUrl}?`,
      cypher: '',
      response: null,
    };
  }

  const json = await res.json();
  if (!res.ok || json?.success === false || json?.error) {
    return {
      ok: false,
      reason: `request_failed: ${json?.error || res.statusText}`,
      cypher: '',
      response: json,
    };
  }

  const cypherBlob = flattenCypherPayload(json);
  const expectAny = containsAny(cypherBlob, testCase.expectAny || []);
  const expectAll = containsAll(cypherBlob, testCase.expectAll || []);

  const forbidMode = testCase.forbidMode === 'all' ? 'all' : 'any';
  const forbidden = Array.isArray(testCase.forbidAny) ? testCase.forbidAny : [];
  const forbidHit =
    forbidMode === 'all'
      ? forbidden.length > 0 && forbidden.every((f) => cypherBlob.includes(f))
      : forbidden.some((f) => cypherBlob.includes(f));

  const ok = expectAny && expectAll && !forbidHit;

  let reason = 'ok';
  if (!expectAny) reason = `missing expectAny: ${JSON.stringify(testCase.expectAny || [])}`;
  else if (!expectAll) reason = `missing expectAll: ${JSON.stringify(testCase.expectAll || [])}`;
  else if (forbidHit) reason = `forbidden pattern matched (${forbidMode})`;

  return {
    ok,
    reason,
    cypher: cypherBlob,
    response: {
      cacheHit: json.cacheHit,
      queryEvaluation: json.queryEvaluation,
      candidateQueries: json.candidateQueries,
    },
  };
}

async function main() {
  const tests = loadCases(casesPath);
  console.log(`Running ${tests.length} query validation case(s) against ${baseUrl}`);

  let passed = 0;
  const failures = [];

  for (const [i, testCase] of tests.entries()) {
    const label = testCase.name || `Case ${i + 1}`;
    try {
      const result = await runCase(testCase);
      if (result.ok) {
        passed += 1;
        console.log(`PASS ${i + 1}/${tests.length}: ${label}`);
      } else {
        console.log(`FAIL ${i + 1}/${tests.length}: ${label}`);
        console.log(`  reason: ${result.reason}`);
        failures.push({ label, ...result });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`FAIL ${i + 1}/${tests.length}: ${label}`);
      console.log(`  reason: ${message}`);
      failures.push({ label, ok: false, reason: message });
    }
  }

  console.log(`\nSummary: ${passed}/${tests.length} passed, ${failures.length} failed`);

  if (failures.length > 0) {
    const reportPath = path.resolve(process.cwd(), 'tests/query-validation/last-failures.json');
    fs.writeFileSync(reportPath, JSON.stringify(failures, null, 2));
    console.log(`Failure report: ${reportPath}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
