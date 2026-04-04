import { getDriver } from '@/lib/neo4j';
import { GRAPH_SCHEMA_DESCRIPTION } from '@/lib/schemaContext';
import { callLLM, LLMMessage, LLMResponse } from '@/lib/llmClients';
import { normalizeTemporalFields } from '@/lib/timeNormalization';

export type ConversationTurn = {
  role: 'user' | 'system';
  content: string;
};

export type InvestigationProgressEvent = {
  stage:
    | 'started'
    | 'planning_query'
    | 'query_ready'
    | 'fetching_data'
    | 'data_fetched'
    | 'calling_models'
    | 'model_done'
    | 'synthesizing'
    | 'completed';
  message: string;
  meta?: Record<string, unknown>;
};

export type InvestigationTurnResult = {
  finalAnswer: string;
  cypher: string;
  records: Record<string, unknown>[];
  modelResponses: LLMResponse[];
  candidateQueries?: string[];
  queryEvaluation?: string;
};

type RunOptions = {
  history?: ConversationTurn[];
  onProgress?: (event: InvestigationProgressEvent) => void | Promise<void>;
};

const MAX_HOPS = 4;
const PATH_RETURN_LIMIT = 10;
const MAX_CANDIDATE_QUERIES = 3;

type QueryCandidate = {
  name: string;
  strategy: 'shortest_path' | 'all_paths' | 'intermediate_path' | 'llm_generated';
  cypher: string;
};

type QueryExecution = {
  candidate: QueryCandidate;
  records: Record<string, unknown>[];
  error?: string;
};

function buildHistoryContext(history: ConversationTurn[]): string {
  if (!history.length) return '';
  const recent = history.slice(-24);
  const context = recent
    .map((turn, idx) => {
      const clean = turn.content.replace(/\s+/g, ' ').trim().slice(0, 700);
      return `${idx + 1}. ${turn.role.toUpperCase()}: ${clean}`;
    })
    .join('\n');
  return `Recent conversation context:\n${context}\n`;
}

function stripCypherFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
}

function normalizeCypherForSafety(cypher: string): string {
  let query = cypher.trim().replace(/;+$/, '');

  // Cap variable-length traversals to MAX_HOPS for CPU safety.
  query = query
    .replace(
      /(\*\s*(\d+)\s*\.\.\s*)(\d+)/g,
      (_, prefix: string, lower: string, upper: string) =>
        `${prefix}${Math.min(Number(upper), MAX_HOPS) || Number(lower)}`,
    )
    .replace(/\*\s*\.\.\s*(\d+)/g, (_m: string, upper: string) => {
      const capped = Math.min(Number(upper), MAX_HOPS) || MAX_HOPS;
      return `*1..${capped}`;
    });

  return query;
}

function escapeCypherLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function extractMsisdn(userQuery: string): string | null {
  const match = userQuery.match(/\b(\d{10,15})\b/);
  return match ? match[1] : null;
}

function extractCellId(userQuery: string): string | null {
  const explicit = userQuery.match(
    /\bcell[_\s-]?id\b\s*[:=]?\s*['"]?([A-Za-z0-9_-]{5,})/i,
  );
  if (explicit) return explicit[1];

  const tower = userQuery.match(/\btower\b\s*[:=]?\s*['"]?([A-Za-z0-9_-]{5,})/i);
  if (tower) return tower[1];

  return null;
}

function detectPhoneToLocationPathIntent(
  userQuery: string,
): { msisdn: string; cellId: string } | null {
  const q = userQuery.toLowerCase();
  const asksPath =
    q.includes('connect') ||
    q.includes('path') ||
    q.includes('linked') ||
    q.includes('relation') ||
    q.includes('tower');

  if (!asksPath) return null;

  const msisdn = extractMsisdn(userQuery);
  const cellId = extractCellId(userQuery);
  if (!msisdn || !cellId) return null;

  return { msisdn, cellId };
}

function buildActivityTypeHint(userQuery: string): string {
  const q = userQuery.toLowerCase();
  if (/call activity|call details|calls|called/.test(q)) {
    return `Activity intent mapping:
- Call activity => CommunicationEvent.type IN ['CALL-IN', 'CALL-OUT']`;
  }

  if (/message activity|sms|text message|messages/.test(q)) {
    return `Activity intent mapping:
- Message activity => CommunicationEvent.type IN ['SMS-IN', 'SMS-OUT', 'DSM-SMS', 'SMS-OUT ROAMING']
- Also allow SMS variants via prefix logic (e.g. ce.type STARTS WITH 'SMS-') when needed`;
  }

  if (/video activity|video call|vdo/.test(q)) {
    return `Activity intent mapping:
- Video activity => CommunicationEvent.type IN ['VDO-IN', 'VDO-OUT']`;
  }

  return '';
}

type Anchor = {
  label: string;
  field: string;
  value: string;
};

function buildInvestigationHeuristicsHint(userQuery: string): string {
  const q = userQuery.toLowerCase();
  const hints: string[] = [];

  if (/most|top|frequent|frequency|repeated|highest/.test(q)) {
    hints.push(
      "- Use aggregation logic (count/distinct count + ORDER BY DESC + LIMIT) for 'most/top/frequent' intents.",
    );
  }
  if (/odd hour|midnight|night|late|before|after|timeline|time window/.test(q)) {
    hints.push(
      '- Apply temporal filtering/windowing and compare activity around incident windows.',
    );
  }
  if (/tower|cell|location|movement|trajectory|hopping|roaming/.test(q)) {
    hints.push(
      '- Use tower/cell sequence analysis and bounded traversal to infer movement patterns.',
    );
  }
  if (/connect|relationship|linked|between|path|network/.test(q)) {
    hints.push(
      '- For relationship-heavy queries, attempt direct, intermediate, then bounded multi-hop traversal [*1..4].',
    );
  }

  return hints.length
    ? `Investigation reasoning hints:\n${hints.join('\n')}`
    : '';
}

function extractAnchors(userQuery: string): Anchor[] {
  const anchors: Anchor[] = [];
  const q = userQuery.toLowerCase();

  const msisdn = extractMsisdn(userQuery);
  if (msisdn) anchors.push({ label: 'PhoneNumber', field: 'msisdn', value: msisdn });

  const cellId = extractCellId(userQuery);
  if (cellId) anchors.push({ label: 'Location', field: 'cell_id', value: cellId });

  const ip = userQuery.match(
    /\b((?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})\b/,
  );
  if (ip) anchors.push({ label: 'IPAddress', field: 'ip', value: ip[1] });

  const imeiMatch = userQuery.match(/\b\d{14,17}\b/);
  if (imeiMatch && /imei|device/.test(q)) {
    anchors.push({ label: 'Device', field: 'imei', value: imeiMatch[0] });
  }

  const accMatch = userQuery.match(
    /\b(?:account(?:\s*number)?|bank(?:\s*account)?)\b[^0-9A-Za-z]*([0-9A-Za-z_-]{6,})/i,
  );
  if (accMatch) {
    anchors.push({
      label: 'BankAccount',
      field: 'account_number',
      value: accMatch[1],
    });
  }

  const sessionMatch = userQuery.match(/\bsession(?:\s*id)?\b[^0-9A-Za-z]*([0-9A-Za-z_-]{4,})/i);
  if (sessionMatch) {
    anchors.push({
      label: 'InternetSession',
      field: 'session_id',
      value: sessionMatch[1],
    });
  }

  const eventMatch = userQuery.match(/\bevent(?:\s*id)?\b[^0-9A-Za-z]*([0-9A-Za-z_-]{4,})/i);
  if (eventMatch) {
    anchors.push({
      label: 'CommunicationEvent',
      field: 'event_id',
      value: eventMatch[1],
    });
  }

  const seen = new Set<string>();
  return anchors.filter((a) => {
    const key = `${a.label}:${a.field}:${a.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function detectGenericComplexRelationshipIntent(
  userQuery: string,
): { a: Anchor; b: Anchor } | null {
  const q = userQuery.toLowerCase();
  const asksRelationship = /connect|relationship|linked|between|associated|path|network|involved/.test(
    q,
  );
  if (!asksRelationship) return null;

  const anchors = extractAnchors(userQuery);
  if (anchors.length < 2) return null;
  return { a: anchors[0], b: anchors[1] };
}

function detectPhoneToImeiIntent(userQuery: string): { msisdn: string } | null {
  const q = userQuery.toLowerCase();
  const asksImei =
    q.includes('imei') ||
    q.includes('device id') ||
    q.includes('device identifier');
  if (!asksImei) return null;

  const msisdn = extractMsisdn(userQuery);
  if (!msisdn) return null;

  return { msisdn };
}

function detectPhoneToIpIntent(userQuery: string): { msisdn: string } | null {
  const q = userQuery.toLowerCase();
  const asksIp =
    q.includes('ip address') ||
    q.includes('ip of') ||
    q.includes('ip for') ||
    q.includes('which ip') ||
    (q.includes('ip') && q.includes('number'));
  if (!asksIp) return null;

  const msisdn = extractMsisdn(userQuery);
  if (!msisdn) return null;
  return { msisdn };
}

function extractIpAddress(userQuery: string): string | null {
  const ip = userQuery.match(
    /\b((?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})\b/,
  );
  return ip ? ip[1] : null;
}

function detectIpToEventIntent(userQuery: string): { ip: string } | null {
  const q = userQuery.toLowerCase();
  const mentionsIpContext =
    q.includes('ip address') || q.includes('ip') || q.includes('i.p');
  if (!mentionsIpContext) return null;

  const asksEvents =
    q.includes('event') ||
    q.includes('activity') ||
    q.includes('involved') ||
    q.includes('session');
  if (!asksEvents) return null;

  const ip = extractIpAddress(userQuery);
  if (!ip) return null;
  return { ip };
}

function buildPhoneToImeiQuery(msisdn: string): string {
  return `MATCH (p:PhoneNumber {msisdn: '${escapeCypherLiteral(msisdn)}'})
OPTIONAL MATCH (p)-[:USED_DEVICE]-(dDirect:Device)
OPTIONAL MATCH (p)-[:SEEN_AT]-(pe:PresenceEvent)-[*1..2]-(dViaPresence:Device)
OPTIONAL MATCH (p)-[*1..4]-(dHop:Device)
WITH [d IN (collect(DISTINCT dDirect) + collect(DISTINCT dViaPresence) + collect(DISTINCT dHop)) WHERE d IS NOT NULL] AS devices
UNWIND devices AS d
RETURN DISTINCT d.imei AS imei
LIMIT 20`;
}

function buildIpToEventCandidates(ip: string): QueryCandidate[] {
  const safeIp = escapeCypherLiteral(ip);
  return [
    {
      name: 'IP to internet sessions (direct)',
      strategy: 'intermediate_path',
      cypher: `MATCH (ip:IPAddress {ip: '${safeIp}'})<-[:CONNECTED_TO]-(is:InternetSession)
RETURN is.session_id AS event_id, is.start_time AS start_time, is.end_time AS end_time, 'InternetSession' AS event_type
LIMIT 200`,
    },
    {
      name: 'IP to internet sessions (undirected fallback)',
      strategy: 'all_paths',
      cypher: `MATCH (ip:IPAddress {ip: '${safeIp}'})-[r:CONNECTED_TO]-(is:InternetSession)
RETURN is.session_id AS event_id, is.start_time AS start_time, is.end_time AS end_time, 'InternetSession' AS event_type, type(r) AS relation
LIMIT 200`,
    },
    {
      name: 'IP via device to internet sessions',
      strategy: 'intermediate_path',
      cypher: `MATCH (ip:IPAddress {ip: '${safeIp}'})<-[:USED]-(d:Device)-[:CONNECTED_TO|USED]-(is:InternetSession)
RETURN DISTINCT is.session_id AS event_id, is.start_time AS start_time, is.end_time AS end_time, d.imei AS device_imei, 'InternetSession' AS event_type
LIMIT 200`,
    },
  ];
}

function buildPhoneToIpCandidates(msisdn: string): QueryCandidate[] {
  const safeMsisdn = escapeCypherLiteral(msisdn);
  return [
    {
      name: 'Phone to IP via internet session (direct)',
      strategy: 'intermediate_path',
      cypher: `MATCH (p:PhoneNumber {msisdn: '${safeMsisdn}'})-[:CONNECTED_TO]-(is:InternetSession)-[:CONNECTED_TO]-(ip:IPAddress)
RETURN DISTINCT ip.ip AS ip_address, is.session_id AS session_id, is.start_time AS start_time, is.end_time AS end_time
LIMIT 200`,
    },
    {
      name: 'Phone to IP via internet session (relationship-flex)',
      strategy: 'all_paths',
      cypher: `MATCH (p:PhoneNumber {msisdn: '${safeMsisdn}'})-[*1..2]-(is:InternetSession)-[r:CONNECTED_TO|USED]-(ip:IPAddress)
RETURN DISTINCT ip.ip AS ip_address, is.session_id AS session_id, is.start_time AS start_time, is.end_time AS end_time, type(r) AS ip_link_type
LIMIT 200`,
    },
    {
      name: 'Phone to IP bounded path evidence',
      strategy: 'shortest_path',
      cypher: `MATCH (p:PhoneNumber {msisdn: '${safeMsisdn}'}), (ip:IPAddress)
MATCH pth = shortestPath((p)-[*1..4]-(ip))
WHERE ANY(n IN nodes(pth) WHERE n:InternetSession)
RETURN pth
LIMIT ${PATH_RETURN_LIMIT}`,
    },
  ];
}

function buildPhoneLocationPathCandidates(
  msisdn: string,
  cellId: string,
): QueryCandidate[] {
  const safeMsisdn = escapeCypherLiteral(msisdn);
  const safeCell = escapeCypherLiteral(cellId);
  return [
    {
      name: 'Shortest bounded path',
      strategy: 'shortest_path',
      cypher: `MATCH (a:PhoneNumber {msisdn: '${safeMsisdn}'}), (b:Location {cell_id: '${safeCell}'})
MATCH p = shortestPath((a)-[*1..${MAX_HOPS}]-(b))
RETURN p
LIMIT ${PATH_RETURN_LIMIT}`,
    },
    {
      name: 'All bounded paths',
      strategy: 'all_paths',
      cypher: `MATCH (a:PhoneNumber {msisdn: '${safeMsisdn}'}), (b:Location {cell_id: '${safeCell}'})
MATCH p = (a)-[*1..${MAX_HOPS}]-(b)
RETURN p
ORDER BY length(p) ASC
LIMIT ${PATH_RETURN_LIMIT}`,
    },
    {
      name: 'Presence-event bridge path',
      strategy: 'intermediate_path',
      cypher: `MATCH (a:PhoneNumber {msisdn: '${safeMsisdn}'})-[:SEEN_AT]-(pe:PresenceEvent)
MATCH (b:Location {cell_id: '${safeCell}'})
MATCH p = (a)-[:SEEN_AT]-(pe)-[*1..2]-(b)
RETURN p, pe
LIMIT ${PATH_RETURN_LIMIT}`,
    },
  ];
}

function buildGenericRelationshipCandidates(a: Anchor, b: Anchor): QueryCandidate[] {
  const safeA = escapeCypherLiteral(a.value);
  const safeB = escapeCypherLiteral(b.value);
  return [
    {
      name: 'Shortest bounded path',
      strategy: 'shortest_path',
      cypher: `MATCH (a:${a.label} {${a.field}: '${safeA}'}), (b:${b.label} {${b.field}: '${safeB}'})
MATCH p = shortestPath((a)-[*1..${MAX_HOPS}]-(b))
RETURN p
LIMIT ${PATH_RETURN_LIMIT}`,
    },
    {
      name: 'All bounded paths',
      strategy: 'all_paths',
      cypher: `MATCH (a:${a.label} {${a.field}: '${safeA}'}), (b:${b.label} {${b.field}: '${safeB}'})
MATCH p = (a)-[*1..${MAX_HOPS}]-(b)
RETURN p
ORDER BY length(p) ASC
LIMIT ${PATH_RETURN_LIMIT}`,
    },
    {
      name: 'Relationship evidence summary',
      strategy: 'intermediate_path',
      cypher: `MATCH (a:${a.label} {${a.field}: '${safeA}'}), (b:${b.label} {${b.field}: '${safeB}'})
MATCH p = (a)-[*1..${MAX_HOPS}]-(b)
UNWIND relationships(p) AS rel
RETURN type(rel) AS relationship_type, count(*) AS occurrences
ORDER BY occurrences DESC
LIMIT 20`,
    },
  ];
}

function detectPathLikeEvidence(record: Record<string, unknown>): boolean {
  return Object.values(record).some((value) => {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return (
      Object.prototype.hasOwnProperty.call(v, 'segments') ||
      Object.prototype.hasOwnProperty.call(v, 'start') ||
      Object.prototype.hasOwnProperty.call(v, 'end')
    );
  });
}

function heuristicScoreExecution(
  execution: QueryExecution,
  asksRelationship: boolean,
): number {
  if (execution.error) return 0;
  let score = 0;
  const count = execution.records.length;
  score += Math.min(count, 20);
  if (count > 0) score += 8;
  if (asksRelationship && execution.records.some(detectPathLikeEvidence)) score += 12;
  if (execution.candidate.strategy === 'all_paths') score += 4;
  if (execution.candidate.strategy === 'intermediate_path') score += 3;
  return score;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const candidate = trimmed.slice(start, end + 1);
  try {
    return JSON.parse(candidate) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function evaluateQueryExecutions(
  userQuery: string,
  executions: QueryExecution[],
  historyContext: string,
): Promise<{ best: QueryExecution; summary: string }> {
  const successful = executions.filter((e) => !e.error);
  if (successful.length === 0) {
    throw new Error('All query strategies failed.');
  }
  if (successful.length === 1) {
    return { best: successful[0], summary: 'Single strategy executed successfully.' };
  }

  const asksRelationship = /connect|relationship|linked|between|associated|path|network|involved|directly|indirectly/.test(
    userQuery.toLowerCase(),
  );
  const compact = successful.map((entry, index) => ({
    index,
    name: entry.candidate.name,
    strategy: entry.candidate.strategy,
    cypher: entry.candidate.cypher,
    recordCount: entry.records.length,
    hasPathEvidence: entry.records.some(detectPathLikeEvidence),
    preview:
      entry.records.length === 0
        ? []
        : JSON.stringify(entry.records.slice(0, 2), null, 2).slice(0, 1200),
  }));

  try {
    const evalResp = await callLLM('openai', 'gpt-4o-mini', [
      {
        role: 'system',
        content:
          'You are an evidence evaluator agent for graph investigations. Pick the best query result set for final analysis with priority on factual path evidence, relationship coverage, and investigative usefulness. Return strict JSON: {"selectedIndex": number, "reason": string}.',
      },
      {
        role: 'user',
        content: `${historyContext}User question:\n${userQuery}\n\nCandidate query outputs:\n${JSON.stringify(
          compact,
          null,
          2,
        )}\n\nSelect one candidate index.`,
      },
    ]);
    const parsed = extractJsonObject(evalResp.content);
    const selectedIndexRaw = parsed?.selectedIndex;
    const selectedIndex =
      typeof selectedIndexRaw === 'number' ? Math.trunc(selectedIndexRaw) : -1;
    const reason = typeof parsed?.reason === 'string' ? parsed.reason.trim() : '';
    if (selectedIndex >= 0 && selectedIndex < successful.length) {
      return {
        best: successful[selectedIndex],
        summary: reason || 'Evaluator selected the most relevant evidence set.',
      };
    }
  } catch {
    // fall through to heuristic selection
  }

  let best = successful[0];
  let bestScore = heuristicScoreExecution(best, asksRelationship);
  for (const execution of successful.slice(1)) {
    const score = heuristicScoreExecution(execution, asksRelationship);
    if (score > bestScore) {
      best = execution;
      bestScore = score;
    }
  }
  return {
    best,
    summary: 'Heuristic evaluator selected the strongest evidence set.',
  };
}

function isSmallTalk(message: string): boolean {
  const trimmed = message.trim().toLowerCase();
  if (!trimmed) return false;

  // Very short, generic interactions – no need to hit Neo4j or multiple LLMs
  const smallTalkPhrases = [
    'hi',
    'hello',
    'hey',
    'good morning',
    'good afternoon',
    'good evening',
    'how are you',
    "what's up",
    'what are you doing',
    'who are you',
    'help',
    'thanks',
    'thank you',
  ];

  if (smallTalkPhrases.includes(trimmed)) return true;

  // Very short, 1–3 word messages with no digits are likely chit-chat
  const wordCount = trimmed.split(/\s+/).length;
  const hasDigit = /\d/.test(trimmed);
  if (wordCount <= 3 && !hasDigit) return true;

  return false;
}

async function generateCypher(
  userQuery: string,
  historyContext: string,
): Promise<string> {
  const system: LLMMessage = {
    role: 'system',
    content: GRAPH_SCHEMA_DESCRIPTION,
  };
  const activityHint = buildActivityTypeHint(userQuery);
  const intelligenceHint = buildInvestigationHeuristicsHint(userQuery);
  const user: LLMMessage = {
    role: 'user',
    content: `${historyContext}User natural language question:\n${userQuery}\n\nCRITICAL PRIMARY-IDENTIFIER RULES (must follow):\n- \"person\" ALWAYS means PhoneNumber.\n- PhoneNumber lookups must use msisdn.\n- BankAccount lookups must use account_number.\n- CommunicationEvent and PresenceEvent lookups must use event_id.\n- Device lookups must use imei.\n- FinancialTransaction lookups must use txn_id.\n- InternetSession lookups must use session_id.\n- IPAddress lookups must use ip.\n- Location lookups must use cell_id.\n- Never use generic node property id for business lookup.\n- For \"called the most\" style questions, aggregate on CommunicationEvent involvement and return highest count counterpart.\n${activityHint ? `\n${activityHint}\n` : ''}${intelligenceHint ? `\n${intelligenceHint}\n` : ''}\nGenerate an appropriate Cypher query over the described schema.`,
  };

  // Use OpenAI mini model as primary query generator
  const response = await callLLM('openai', 'gpt-4o-mini', [system, user]);
  return normalizeCypherForSafety(stripCypherFence(response.content));
}

async function runCypher(cypher: string): Promise<Record<string, unknown>[]> {
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(cypher);
    const records = result.records.map((record) => {
      const obj: Record<string, unknown> = {};
      record.keys.forEach((key) => {
        const field = String(key);
        obj[field] = record.get(field);
      });
      return normalizeTemporalFields(obj);
    });
    return records;
  } finally {
    await session.close();
  }
}

async function synthesizeFinalAnswer(
  userQuery: string,
  cypher: string,
  records: Record<string, unknown>[],
  modelResponses: LLMResponse[],
  historyContext: string,
  queryEvaluation?: string,
): Promise<string> {
  const system: LLMMessage = {
    role: 'system',
    content:
      'You are a senior investigative analyst. You receive multiple model opinions and the underlying graph query and results. Your job is to synthesize them into ONE clear, concise answer for a police officer.\n\nVERY IMPORTANT OUTPUT RULES:\n- Start with a direct answer in 2–4 short sentences.\n- When the user explicitly asks to “show data”, prefer **tables or bullet-point lists of records** instead of long narrative reports.\n- Format output in valid Markdown for UI rendering.\n- When showing a table, use proper GitHub-style markdown table syntax with a header separator row.\n- If the user asks for a flow chart or diagram, output Mermaid inside a fenced block: ```mermaid ... ```.\n- Avoid email-style headers (no To:, From:, Subject:, dates, or greetings like “Hello Officer”).\n- Prefer neutral section headings like “Facts from the Data” only when useful.\n- Prefer statements that are clearly supported by the data.\n- If models disagree, call out the uncertainty and explain which parts are certain vs speculative.\n- Always distinguish facts (directly in the data) from hypotheses.\n- If the data is insufficient for a conclusion, say so and optionally suggest follow-up queries.',
  };

  const recordsJson =
    records.length === 0
      ? '[]'
      : JSON.stringify(records, null, 2).slice(0, 6000);

  const opinionsBlock = modelResponses
    .map(
      (r) =>
        `---\nProvider: ${r.provider}\nModel: ${r.model}\nOpinion:\n${r.content}\n`,
    )
    .join('\n');

  const user: LLMMessage = {
    role: 'user',
    content: `${historyContext}User question:\n${userQuery}\n\nCypher executed:\n${cypher}\n\nQuery-evaluation note:\n${queryEvaluation || 'N/A'}\n\nRaw records (JSON slice):\n${recordsJson}\n\nModel opinions:\n${opinionsBlock}\n\nNow produce the final answer for the officer, following the rules.`,
  };

  // Use OpenAI mini model for final synthesis
  const synth = await callLLM('openai', 'gpt-4o-mini', [system, user]);
  return synth.content.trim();
}

export async function runInvestigationTurn(
  userQuery: string,
  options: RunOptions = {},
): Promise<InvestigationTurnResult> {
  const emit = async (event: InvestigationProgressEvent) => {
    if (options.onProgress) {
      await options.onProgress(event);
    }
  };
  const historyContext = buildHistoryContext(options.history ?? []);

  await emit({
    stage: 'started',
    message: 'Agent initialized the investigation turn.',
  });

  // 0) Handle simple small-talk / meta questions without hitting Neo4j
  if (isSmallTalk(userQuery)) {
    const system: LLMMessage = {
      role: 'system',
      content:
        'You are a polite, concise police investigation assistant. The user is just greeting or asking simple meta-questions. Respond briefly and naturally, and do NOT mention databases, Cypher, or internal architecture unless explicitly asked.',
    };
    const user: LLMMessage = {
      role: 'user',
      content: userQuery,
    };

    const resp = await callLLM('openai', 'gpt-4o-mini', [system, user]);
    await emit({
      stage: 'completed',
      message: 'Responded directly without running database analysis.',
    });

    return {
      finalAnswer: resp.content.trim(),
      cypher: '',
      records: [],
      modelResponses: [resp],
    };
  }

  // 1) Generate Cypher from NL
  await emit({
    stage: 'planning_query',
    message: 'Planning graph query from your natural language request.',
  });
  const pathIntent = detectPhoneToLocationPathIntent(userQuery);
  const imeiIntent = detectPhoneToImeiIntent(userQuery);
  const phoneIpIntent = detectPhoneToIpIntent(userQuery);
  const ipEventIntent = detectIpToEventIntent(userQuery);
  const genericIntent = detectGenericComplexRelationshipIntent(userQuery);
  let candidateQueries: QueryCandidate[] = [];
  if (pathIntent) {
    candidateQueries = buildPhoneLocationPathCandidates(
      pathIntent.msisdn,
      pathIntent.cellId,
    );
    await emit({
      stage: 'planning_query',
      message: `Detected path-traversal intent between ${pathIntent.msisdn} and cell ${pathIntent.cellId}. Building multiple bounded traversal strategies.`,
    });
  } else if (imeiIntent) {
    candidateQueries = [
      {
        name: 'Phone to IMEI lookup',
        strategy: 'intermediate_path',
        cypher: buildPhoneToImeiQuery(imeiIntent.msisdn),
      },
    ];
    await emit({
      stage: 'planning_query',
      message: `Detected IMEI lookup intent for phone ${imeiIntent.msisdn}. Using bounded indirect traversal to Device nodes.`,
    });
  } else if (phoneIpIntent) {
    candidateQueries = buildPhoneToIpCandidates(phoneIpIntent.msisdn);
    await emit({
      stage: 'planning_query',
      message: `Detected phone-to-IP intent for ${phoneIpIntent.msisdn}. Prioritizing InternetSession bridge queries.`,
    });
  } else if (ipEventIntent) {
    candidateQueries = buildIpToEventCandidates(ipEventIntent.ip);
    await emit({
      stage: 'planning_query',
      message: `Detected IP-to-event intent for ${ipEventIntent.ip}. Prioritizing InternetSession evidence queries.`,
    });
  } else if (genericIntent) {
    candidateQueries = buildGenericRelationshipCandidates(
      genericIntent.a,
      genericIntent.b,
    );
    await emit({
      stage: 'planning_query',
      message: `Detected complex relationship intent between ${genericIntent.a.label}.${genericIntent.a.field} and ${genericIntent.b.label}.${genericIntent.b.field}. Building shortest-path and multi-path strategies.`,
    });
  } else {
    candidateQueries = [
      {
        name: 'Generated Cypher',
        strategy: 'llm_generated',
        cypher: await generateCypher(userQuery, historyContext),
      },
    ];
  }
  candidateQueries = candidateQueries.slice(0, MAX_CANDIDATE_QUERIES);
  await emit({
    stage: 'query_ready',
    message: `Prepared ${candidateQueries.length} query strategy(s).`,
    meta: {
      cypher: candidateQueries[0]?.cypher || '',
      candidateQueries: candidateQueries.map((q) => ({
        name: q.name,
        strategy: q.strategy,
        cypher: q.cypher,
      })),
    },
  });

  // 2) Execute Neo4j query
  await emit({
    stage: 'fetching_data',
    message: `Executing ${candidateQueries.length} strategy query(ies) against Neo4j.`,
  });
  const executions: QueryExecution[] = [];
  for (let i = 0; i < candidateQueries.length; i++) {
    const candidate = candidateQueries[i];
    await emit({
      stage: 'fetching_data',
      message: `Running strategy ${i + 1}/${candidateQueries.length}: ${candidate.name}.`,
      meta: { cypher: candidate.cypher, strategy: candidate.strategy },
    });
    try {
      const resultRows = await runCypher(candidate.cypher);
      executions.push({ candidate, records: resultRows });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      executions.push({ candidate, records: [], error: message });
      await emit({
        stage: 'fetching_data',
        message: `Strategy failed (${candidate.name}): ${message}`,
      });
    }
  }
  const nonFailed = executions.filter((e) => !e.error);
  if (nonFailed.length === 0) {
    throw new Error(
      executions.map((e) => `${e.candidate.name}: ${e.error || 'Unknown error'}`).join(' | '),
    );
  }
  await emit({
    stage: 'fetching_data',
    message:
      'Evaluating query strategy outputs to select the strongest investigation evidence.',
  });
  const evaluation = await evaluateQueryExecutions(
    userQuery,
    executions,
    historyContext,
  );
  const cypher = evaluation.best.candidate.cypher;
  const records = evaluation.best.records;
  const queryEvaluation = `Selected strategy: ${evaluation.best.candidate.name} (${evaluation.best.candidate.strategy}). ${evaluation.summary}`;
  await emit({
    stage: 'data_fetched',
    message: `Selected best strategy and fetched ${records.length} record(s) from the graph.`,
    meta: {
      recordCount: records.length,
      preview: records.slice(0, 3),
      queryEvaluation,
    },
  });

  // 3) Ask three models for interpretations
  await emit({
    stage: 'calling_models',
    message: 'Calling analysis models in parallel.',
  });
  const [openaiResp, groqResp] = await Promise.all([
    callLLM('openai', 'gpt-4o-mini', [
      {
        role: 'system',
        content:
          'You are an investigative assistant for police analysts. You are given a user question and raw graph query results from Neo4j. Explain clearly, cautiously, and WITHOUT hallucinating facts not grounded in the data. If data is missing or ambiguous, say so explicitly.',
      },
      {
        role: 'user',
        content: `${historyContext}User question:\n${userQuery}\n\nCypher executed:\n${cypher}\n\nRaw records (JSON):\n${
          records.length === 0
            ? '[]'
            : JSON.stringify(records, null, 2).slice(0, 8000)
        }\n\nExplain what this data says in a way a police officer can understand. Highlight key entities, locations, times, and relationships. If the answer is incomplete, mention what additional data would be needed, but do NOT invent records.`,
      },
    ]).then((resp) => {
      void emit({
        stage: 'model_done',
        message: `Model completed: ${resp.provider} (${resp.model}).`,
        meta: { provider: resp.provider, model: resp.model },
      });
      return resp;
    }),
    callLLM('groq', 'llama-3.3-70b-versatile', [
      {
        role: 'system',
        content:
          'You are an investigative assistant for police analysts. You are given a user question and raw graph query results from Neo4j. Explain clearly, cautiously, and WITHOUT hallucinating facts not grounded in the data. If data is missing or ambiguous, say so explicitly.',
      },
      {
        role: 'user',
        content: `${historyContext}User question:\n${userQuery}\n\nCypher executed:\n${cypher}\n\nRaw records (JSON):\n${
          records.length === 0
            ? '[]'
            : JSON.stringify(records, null, 2).slice(0, 8000)
        }\n\nExplain what this data says in a way a police officer can understand. Highlight key entities, locations, times, and relationships. If the answer is incomplete, mention what additional data would be needed, but do NOT invent records.`,
      },
    ]).then((resp) => {
      void emit({
        stage: 'model_done',
        message: `Model completed: ${resp.provider} (${resp.model}).`,
        meta: { provider: resp.provider, model: resp.model },
      });
      return resp;
    }),
  ]);
  const modelResponses = [openaiResp, groqResp];

  // 4) Synthesize final answer
  await emit({
    stage: 'synthesizing',
    message: 'Synthesizing final response.',
  });
  const finalAnswer = await synthesizeFinalAnswer(
    userQuery,
    cypher,
    records,
    modelResponses,
    historyContext,
    queryEvaluation,
  );
  await emit({
    stage: 'completed',
    message: 'Final response ready.',
  });

  return {
    finalAnswer,
    cypher,
    records,
    modelResponses,
    candidateQueries: candidateQueries.map((q) => q.cypher),
    queryEvaluation,
  };
}
