import { getDriver } from '@/lib/neo4j';
import { GRAPH_SCHEMA_DESCRIPTION } from '@/lib/schemaContext';
import { callLLM, LLMMessage, LLMResponse } from '@/lib/llmClients';
import { normalizeTemporalFields } from '@/lib/timeNormalization';
import {
  extractGraphFromRecords,
  GraphPayload,
  serializeNeo4jRecord,
} from '@/lib/graphPayload';

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
  graph?: GraphPayload;
  modelResponses: LLMResponse[];
  candidateQueries?: string[];
  queryEvaluation?: string;
};

type RunOptions = {
  history?: ConversationTurn[];
  includeGraph?: boolean;
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
  executedCypher: string;
  records: Record<string, unknown>[];
  graph?: GraphPayload;
  error?: string;
};

function buildHistoryContext(history: ConversationTurn[]): string {
  if (!history.length) return '';
  const recent = history.slice(-24);
  const context = recent
    .map((turn, idx) => {
      const clean = turn.content
        .replace(
          /\b(\d{4}-\d{2}-\d{2})\s+00:00:00\s+(\d{2}:\d{2}:\d{2})\b/g,
          '$1 $2',
        )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 700);
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

  query = repairCypherTemporalLiterals(query);

  return query;
}

function isTemporalParseError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('cannot be parsed to a datetime') ||
    m.includes('cannot be parsed to a date') ||
    (m.includes('datetime') && m.includes('cannot be parsed'))
  );
}

function repairCypherTemporalLiterals(cypher: string): string {
  let query = cypher;

  // Fix duplicated time fragments:
  // datetime('YYYY-MM-DD HH:MM:SS HH:MM:SS') -> datetime('YYYY-MM-DDTHH:MM:SS') using last time.
  query = query.replace(
    /datetime\(\s*'(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+(\d{2}:\d{2}:\d{2})'\s*\)/gi,
    (_m, d: string, _t1: string, t2: string) => `datetime('${d}T${t2}')`,
  );

  // Normalize datetime('YYYY-MM-DD HH:MM:SS') -> datetime('YYYY-MM-DDTHH:MM:SS')
  query = query.replace(
    /datetime\(\s*'(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})'\s*\)/gi,
    (_m, d: string, t: string) => `datetime('${d}T${t}')`,
  );

  // Normalize datetime("YYYY-MM-DD ...") with double-quoted literals.
  query = query.replace(
    /datetime\(\s*"(\d{4}-\d{2}-\d{2})\s+([^"]+)"\s*\)/gi,
    (_m, d: string, tail: string) => {
      const times = tail.match(/\d{2}:\d{2}:\d{2}/g);
      const chosen = times && times.length ? times[times.length - 1] : '00:00:00';
      return `datetime('${d}T${chosen}')`;
    },
  );

  // date('YYYY-MM-DD HH:MM:SS' [HH:MM:SS]) -> date('YYYY-MM-DD')
  query = query.replace(
    /date\(\s*'(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}:\d{2}(?:\s+\d{2}:\d{2}:\d{2})?'\s*\)/gi,
    (_m, d: string) => `date('${d}')`,
  );

  // date('YYYY-MM-DD ...anything...') -> date('YYYY-MM-DD')
  query = query.replace(
    /date\(\s*'(\d{4}-\d{2}-\d{2})[^']*'\s*\)/gi,
    (_m, d: string) => `date('${d}')`,
  );

  // date("YYYY-MM-DD ...") -> date('YYYY-MM-DD')
  query = query.replace(
    /date\(\s*"(\d{4}-\d{2}-\d{2})[^"]*"\s*\)/gi,
    (_m, d: string) => `date('${d}')`,
  );

  return query;
}

function escapeCypherLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function extractMsisdn(userQuery: string): string | null {
  const match = userQuery.match(/\b(\d{10,15})\b/);
  return match ? match[1] : null;
}

function extractAllMsisdns(userQuery: string): string[] {
  const matches = userQuery.match(/\b(\d{10,15})\b/g) || [];
  return Array.from(new Set(matches));
}

function extractLatestTwoMsisdnsFromHistory(history: ConversationTurn[]): [string, string] | null {
  const found: string[] = [];
  const seen = new Set<string>();
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    if (turn.role !== 'user') continue;
    const nums = extractAllMsisdns(turn.content);
    for (const n of nums) {
      if (seen.has(n)) continue;
      seen.add(n);
      found.push(n);
      if (found.length >= 2) {
        return [found[1], found[0]];
      }
    }
  }
  return null;
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

function extractEventId(userQuery: string): string | null {
  const explicit = userQuery.match(
    /\bevent(?:\s*id)?\b\s*[:=]?\s*['"]?([0-9a-fA-F-]{16,})/i,
  );
  if (explicit) return explicit[1];
  const uuid = userQuery.match(
    /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/,
  );
  return uuid ? uuid[0] : null;
}

function detectEventLocationIntent(
  userQuery: string,
): { eventId: string } | null {
  const q = userQuery.toLowerCase();
  const asksLocation = /\blocation\b|\bcell\b|\bcell id\b|\btower\b|\bwhere\b/.test(
    q,
  );
  if (!asksLocation) return null;
  const eventId = extractEventId(userQuery);
  if (!eventId) return null;
  return { eventId };
}

function buildEventLocationFromBothSourcesQuery(eventId: string): string {
  const safeEventId = escapeCypherLiteral(eventId);
  return `MATCH (ce:CommunicationEvent {event_id: '${safeEventId}'})
OPTIONAL MATCH (src:PhoneNumber)-[:INITIATED]->(ce)
OPTIONAL MATCH (ce)-[:TARGET]->(dst:PhoneNumber)
WITH ce, [n IN (collect(DISTINCT src.msisdn) + collect(DISTINCT dst.msisdn)) WHERE n IS NOT NULL] AS linked_numbers
UNWIND CASE WHEN size(linked_numbers) = 0 THEN [NULL] ELSE linked_numbers END AS linked_msisdn
OPTIONAL MATCH (p:PhoneNumber {msisdn: linked_msisdn})-[:SEEN_AT]-(pe:PresenceEvent)-[:AT_LOCATION]-(loc:Location)
WITH ce, linked_numbers, collect(DISTINCT {
  presence_event_id: pe.event_id,
  presence_type: pe.type,
  presence_timestamp: toString(coalesce(pe.timestamp, pe.time_stamp)),
  cell_id: loc.cell_id
}) AS pe_candidates
WITH ce, linked_numbers,
  [pc IN pe_candidates WHERE pc.presence_timestamp IS NOT NULL AND (
    replace(pc.presence_timestamp, ' 00:00:00 ', ' ') = replace(toString(ce.timestamp), ' 00:00:00 ', ' ')
    OR right(replace(pc.presence_timestamp, ' 00:00:00 ', ' '), 8) = right(replace(toString(ce.timestamp), ' 00:00:00 ', ' '), 8)
  )] AS matched_presence
RETURN
  'CommunicationEvent' AS source_event_label,
  ce.event_id AS event_id,
  ce.type AS event_type,
  toString(ce.timestamp) AS event_timestamp,
  ce.duration AS event_duration,
  linked_numbers,
  [m IN matched_presence | m.presence_event_id] AS matched_presence_event_ids,
  [m IN matched_presence | m.cell_id] AS inferred_cell_ids,
  [m IN matched_presence | m.presence_timestamp] AS matched_presence_timestamps
UNION ALL
MATCH (pe:PresenceEvent {event_id: '${safeEventId}'})-[:AT_LOCATION]-(loc:Location)
OPTIONAL MATCH (p:PhoneNumber)-[:SEEN_AT]-(pe)
RETURN
  'PresenceEvent' AS source_event_label,
  pe.event_id AS event_id,
  pe.type AS event_type,
  toString(coalesce(pe.timestamp, pe.time_stamp)) AS event_timestamp,
  pe.duration AS event_duration,
  collect(DISTINCT p.msisdn) AS linked_numbers,
  [pe.event_id] AS matched_presence_event_ids,
  collect(DISTINCT loc.cell_id) AS inferred_cell_ids,
  [toString(coalesce(pe.timestamp, pe.time_stamp))] AS matched_presence_timestamps
LIMIT 20`;
}

function extractLatestCellIdFromHistory(history: ConversationTurn[]): string | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    const explicit = extractCellId(turn.content);
    if (explicit) return explicit;
    const generic = turn.content.match(/\b(?=[A-Z0-9_-]{8,}\b)(?=.*[A-Z])(?=.*\d)[A-Z0-9_-]+\b/);
    if (generic) return generic[0];
  }
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

function detectPhoneEventsAtCellIntent(
  userQuery: string,
): { msisdn: string; cellId: string } | null {
  const q = userQuery.toLowerCase();
  const asksEventsAtCell =
    (/\bevent\b|\bevents\b|\bactivity\b/.test(q) &&
      /\bcell\b|\bcell id\b|\btower\b|\blocation\b/.test(q)) ||
    /\bevents?\s+at\s+cell/.test(q);
  if (!asksEventsAtCell) return null;

  const msisdn = extractMsisdn(userQuery);
  const cellId = extractCellId(userQuery);
  if (!msisdn || !cellId) return null;
  return { msisdn, cellId };
}

function buildPhoneEventsAtCellQuery(msisdn: string, cellId: string): string {
  const safeMsisdn = escapeCypherLiteral(msisdn);
  const safeCellId = escapeCypherLiteral(cellId);
  return `MATCH (p:PhoneNumber {msisdn: '${safeMsisdn}'})-[:INITIATED|TARGET]-(ce:CommunicationEvent)
WITH p, ce, toString(ce.timestamp) AS ce_ts, right(toString(ce.timestamp), 8) AS ce_tod
MATCH (p)-[:SEEN_AT]-(pe:PresenceEvent)-[:AT_LOCATION]-(l:Location {cell_id: '${safeCellId}'})
WITH ce, ce_ts, ce_tod, l, toString(coalesce(pe.timestamp, pe.time_stamp)) AS pe_ts, right(toString(coalesce(pe.timestamp, pe.time_stamp)), 8) AS pe_tod
WHERE ce_ts = pe_ts OR ce_tod = pe_tod
RETURN DISTINCT ce.event_id AS event_id, ce.type AS event_type, ce.timestamp AS event_timestamp, ce.duration AS event_duration, l.cell_id AS cell_id, pe_ts AS matched_presence_timestamp
ORDER BY ce.timestamp DESC
LIMIT 200`;
}

function detectPhoneToPhoneLinkIntent(
  userQuery: string,
): { a: string; b: string } | null {
  const msisdns = extractAllMsisdns(userQuery);
  if (msisdns.length < 2) return null;

  const q = userQuery.toLowerCase();
  const linkWords =
    /connect|connected|relation|relationship|link|linked|path|hidden|between|network|try for/.test(
      q,
    );

  // If user provided exactly two phone-like numbers, prefer hidden-link strategy
  // for investigation prompts even when phrasing is brief (e.g., "try for X and Y").
  if (!linkWords && msisdns.length !== 2) return null;
  return { a: msisdns[0], b: msisdns[1] };
}

function detectCoLocationIntent(
  userQuery: string,
): { a: string; b: string; cellId?: string } | null {
  const msisdns = extractAllMsisdns(userQuery);
  if (msisdns.length < 2) return null;
  const q = userQuery.toLowerCase();
  const asksCoLocation =
    /same place|same location|located in same|same cell|co-?location|at any time|together at/.test(
      q,
    );
  if (!asksCoLocation) return null;
  const cellId = extractCellId(userQuery) || undefined;
  return { a: msisdns[0], b: msisdns[1], cellId };
}

function detectCoLocationTimeFollowUpIntent(
  userQuery: string,
  history: ConversationTurn[],
): { a: string; b: string; cellId?: string } | null {
  const q = userQuery.toLowerCase();
  const asksTime =
    /\bwhen\b|\bwhat time\b|\bat what\b|\btime\b|\btimestamp\b/.test(q);
  const asksPlace =
    /\bcell\b|\blocation\b|\bsame place\b|\bthat cell\b|\bthat location\b/.test(q);
  const referencesPair = /\bthey\b|\bboth\b/.test(q);
  if (!asksTime || !asksPlace || !referencesPair) return null;

  const pair = extractLatestTwoMsisdnsFromHistory(history);
  if (!pair) return null;
  const cellId = extractCellId(userQuery) || extractLatestCellIdFromHistory(history) || undefined;
  return { a: pair[0], b: pair[1], cellId };
}

function buildCoLocationCandidates(
  aMsisdn: string,
  bMsisdn: string,
  cellId?: string,
): QueryCandidate[] {
  const a = escapeCypherLiteral(aMsisdn);
  const b = escapeCypherLiteral(bMsisdn);
  const cellFilter = cellId ? `AND loc.cell_id = '${escapeCypherLiteral(cellId)}'` : '';
  return [
    {
      name: 'Shared location with presence timestamps',
      strategy: 'intermediate_path',
      cypher: `MATCH (a:PhoneNumber {msisdn: '${a}'})-[:SEEN_AT]-(pea:PresenceEvent)-[:AT_LOCATION]-(loc:Location)
MATCH (b:PhoneNumber {msisdn: '${b}'})-[:SEEN_AT]-(peb:PresenceEvent)-[:AT_LOCATION]-(loc)
WHERE 1=1
  ${cellFilter}
WITH a, b, loc,
  collect(DISTINCT pea.event_id) AS a_event_ids,
  collect(DISTINCT peb.event_id) AS b_event_ids,
  collect(DISTINCT coalesce(pea.timestamp, pea.time_stamp)) AS a_timestamps,
  collect(DISTINCT coalesce(peb.timestamp, peb.time_stamp)) AS b_timestamps
RETURN a.msisdn AS number_a, b.msisdn AS number_b, loc.cell_id AS cell_id, a_event_ids[0..100] AS a_event_ids, b_event_ids[0..100] AS b_event_ids, a_timestamps[0..100] AS a_timestamps, b_timestamps[0..100] AS b_timestamps, size(a_timestamps) + size(b_timestamps) AS link_strength
ORDER BY link_strength DESC
LIMIT 20`,
    },
    {
      name: 'Shared location summary fallback',
      strategy: 'all_paths',
      cypher: `MATCH (a:PhoneNumber {msisdn: '${a}'})-[:SEEN_AT]-(:PresenceEvent)-[:AT_LOCATION]-(loc:Location)<-[:AT_LOCATION]-(:PresenceEvent)-[:SEEN_AT]-(b:PhoneNumber {msisdn: '${b}'})
WHERE 1=1
  ${cellFilter}
RETURN a.msisdn AS number_a, b.msisdn AS number_b, collect(DISTINCT loc.cell_id)[0..100] AS common_cell_ids, size(collect(DISTINCT loc.cell_id)) AS common_cell_count
LIMIT 1`,
    },
  ];
}

function buildPhoneToPhoneLinkCandidates(aMsisdn: string, bMsisdn: string): QueryCandidate[] {
  const a = escapeCypherLiteral(aMsisdn);
  const b = escapeCypherLiteral(bMsisdn);
  return [
    {
      name: 'Shortest bounded path (with chain evidence)',
      strategy: 'shortest_path',
      cypher: `MATCH (a:PhoneNumber {msisdn: '${a}'}), (b:PhoneNumber {msisdn: '${b}'})
MATCH p = shortestPath((a)-[*1..${MAX_HOPS}]-(b))
RETURN p, length(p) AS hop_count, [r IN relationships(p) | type(r)] AS relationship_chain
LIMIT ${PATH_RETURN_LIMIT}`,
    },
    {
      name: 'All bounded paths (ranked)',
      strategy: 'all_paths',
      cypher: `MATCH (a:PhoneNumber {msisdn: '${a}'}), (b:PhoneNumber {msisdn: '${b}'})
MATCH p = (a)-[*1..${MAX_HOPS}]-(b)
RETURN p, length(p) AS hop_count, [r IN relationships(p) | type(r)] AS relationship_chain
ORDER BY hop_count ASC
LIMIT ${PATH_RETURN_LIMIT}`,
    },
    {
      name: 'Shared communication/location evidence with temporal overlap',
      strategy: 'intermediate_path',
      cypher: `MATCH (a:PhoneNumber {msisdn: '${a}'}), (b:PhoneNumber {msisdn: '${b}'})
OPTIONAL MATCH (a)-[:INITIATED|TARGET]-(ce:CommunicationEvent)-[:INITIATED|TARGET]-(b)
OPTIONAL MATCH (a)-[:SEEN_AT]-(pea:PresenceEvent)-[:AT_LOCATION]-(loc:Location)<-[:AT_LOCATION]-(peb:PresenceEvent)-[:SEEN_AT]-(b)
WITH a, b, ce, loc,
  collect(DISTINCT toString(coalesce(pea.timestamp, pea.time_stamp))) AS a_presence_timestamps,
  collect(DISTINCT toString(coalesce(peb.timestamp, peb.time_stamp))) AS b_presence_timestamps,
  collect(DISTINCT pea.duration) AS a_presence_durations,
  collect(DISTINCT peb.duration) AS b_presence_durations
WITH a, b,
  collect(DISTINCT ce.event_id) AS common_event_ids,
  collect(DISTINCT loc.cell_id) AS common_cell_ids,
  collect(DISTINCT {
    cell_id: loc.cell_id,
    a_timestamps: a_presence_timestamps,
    b_timestamps: b_presence_timestamps,
    a_durations: a_presence_durations,
    b_durations: b_presence_durations
  }) AS co_location_evidence
WITH a, b, common_event_ids, common_cell_ids, co_location_evidence,
  [x IN co_location_evidence WHERE x.cell_id IS NOT NULL] AS valid_location_evidence
UNWIND CASE WHEN size(valid_location_evidence) = 0 THEN [NULL] ELSE valid_location_evidence END AS ev
WITH a, b, common_event_ids, common_cell_ids, valid_location_evidence, ev,
  CASE
    WHEN ev IS NULL THEN []
    ELSE [t IN [x IN ev.a_timestamps | right(replace(x, ' 00:00:00 ', ' '), 8)]
      WHERE t IN [y IN ev.b_timestamps | right(replace(y, ' 00:00:00 ', ' '), 8)]]
  END AS overlap_tod
WITH a, b, common_event_ids, common_cell_ids, valid_location_evidence,
  collect(DISTINCT {cell_id: CASE WHEN ev IS NULL THEN NULL ELSE ev.cell_id END, overlap_tod: overlap_tod}) AS overlap_evidence
WITH a, b, common_event_ids, common_cell_ids, valid_location_evidence,
  [o IN overlap_evidence WHERE o.cell_id IS NOT NULL] AS overlap_evidence_clean
RETURN a.msisdn AS number_a,
  b.msisdn AS number_b,
  common_event_ids,
  common_cell_ids,
  valid_location_evidence[0..20] AS co_location_evidence,
  overlap_evidence_clean[0..20] AS overlap_evidence,
  reduce(s = 0, o IN overlap_evidence_clean | s + size(o.overlap_tod)) AS temporal_overlap_count,
  size(common_event_ids) + size(common_cell_ids) + reduce(s = 0, o IN overlap_evidence_clean | s + size(o.overlap_tod)) AS link_strength
LIMIT 1`,
    },
    {
      name: 'Co-location overlap timeline',
      strategy: 'intermediate_path',
      cypher: `MATCH (a:PhoneNumber {msisdn: '${a}'})-[:SEEN_AT]-(pea:PresenceEvent)-[:AT_LOCATION]-(loc:Location)<-[:AT_LOCATION]-(peb:PresenceEvent)-[:SEEN_AT]-(b:PhoneNumber {msisdn: '${b}'})
WITH loc,
  toString(coalesce(pea.timestamp, pea.time_stamp)) AS a_ts,
  toString(coalesce(peb.timestamp, peb.time_stamp)) AS b_ts,
  right(replace(toString(coalesce(pea.timestamp, pea.time_stamp)), ' 00:00:00 ', ' '), 8) AS a_tod,
  right(replace(toString(coalesce(peb.timestamp, peb.time_stamp)), ' 00:00:00 ', ' '), 8) AS b_tod,
  pea.duration AS a_duration,
  peb.duration AS b_duration
WHERE a_tod = b_tod
RETURN loc.cell_id AS cell_id, a_ts AS number_a_presence_timestamp, b_ts AS number_b_presence_timestamp, a_duration, b_duration, a_tod AS matched_time_of_day
ORDER BY cell_id ASC, matched_time_of_day ASC
LIMIT 200`,
    },
  ];
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

function extractIsoDate(userQuery: string): string | null {
  const iso = userQuery.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];

  const dmy = userQuery.match(/\b(\d{2})[/-](\d{2})[/-](20\d{2})\b/);
  if (dmy) {
    const dd = dmy[1];
    const mm = dmy[2];
    const yyyy = dmy[3];
    return `${yyyy}-${mm}-${dd}`;
  }
  return null;
}

function isoDateToExcelSerial(dateIso: string): string | null {
  const m = dateIso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const yyyy = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  if (!Number.isFinite(yyyy) || !Number.isFinite(mm) || !Number.isFinite(dd)) {
    return null;
  }
  const base = Date.UTC(1899, 11, 30, 0, 0, 0);
  const target = Date.UTC(yyyy, mm - 1, dd, 0, 0, 0);
  const serial = Math.floor((target - base) / 86_400_000);
  return Number.isFinite(serial) ? String(serial) : null;
}

function extractLatestMsisdnFromHistory(history: ConversationTurn[]): string | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    if (turn.role !== 'user') continue;
    const msisdn = extractMsisdn(turn.content);
    if (msisdn) return msisdn;
  }
  return null;
}

function extractLatestDateFromHistory(history: ConversationTurn[]): string | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    if (turn.role !== 'user') continue;
    const date = extractIsoDate(turn.content);
    if (date) return date;
  }
  return null;
}

function hasSameDateReference(userQuery: string): boolean {
  return /\bsame date\b|\bthat date\b|\bsame day\b/i.test(userQuery);
}

function detectCallActivityIntent(
  userQuery: string,
  history: ConversationTurn[],
): { msisdn: string; date?: string; direction: 'all' | 'received' | 'outgoing' } | null {
  const q = userQuery.toLowerCase();
  const asksCallActivity =
    q.includes('call activity') ||
    q.includes('call details') ||
    /\bcalls\b/.test(q);
  if (!asksCallActivity) return null;

  const msisdn = extractMsisdn(userQuery) || extractLatestMsisdnFromHistory(history);
  if (!msisdn) return null;

  const explicitDate = extractIsoDate(userQuery);
  const sameDateRef = hasSameDateReference(userQuery);
  const date =
    explicitDate || (sameDateRef ? extractLatestDateFromHistory(history) : null) || undefined;

  const direction: 'all' | 'received' | 'outgoing' = /\breceived\b|\bincoming\b/.test(q)
    ? 'received'
    : /\boutgoing\b|\bmade\b|\bdialed\b/.test(q)
      ? 'outgoing'
      : 'all';

  return { msisdn, date, direction };
}

function buildCallActivityMergedQuery(
  msisdn: string,
  date?: string,
  mode: 'all' | 'received' | 'outgoing' = 'all',
): string {
  const safeMsisdn = escapeCypherLiteral(msisdn);
  const safeDate = date ? escapeCypherLiteral(date) : '';
  const dateSerial = date ? isoDateToExcelSerial(date) : null;

  const ceDateFilter = date
    ? `AND toString(ce.timestamp) STARTS WITH '${safeDate}'`
    : '';
  const peDateFilter = date
    ? `AND (
  toString(coalesce(pe.timestamp, pe.time_stamp)) STARTS WITH '${safeDate}'
  ${dateSerial ? `OR toString(coalesce(pe.timestamp, pe.time_stamp)) STARTS WITH '${dateSerial}'` : ''}
)`
    : '';
  const ceDirFilter =
    mode === 'received'
      ? "AND toUpper(coalesce(ce.type, '')) STARTS WITH 'CALL-IN'"
      : mode === 'outgoing'
        ? "AND toUpper(coalesce(ce.type, '')) STARTS WITH 'CALL-OUT'"
        : '';
  const peDirFilter =
    mode === 'received'
      ? "AND toUpper(coalesce(pe.type, '')) STARTS WITH 'CALL-IN'"
      : mode === 'outgoing'
        ? "AND toUpper(coalesce(pe.type, '')) STARTS WITH 'CALL-OUT'"
        : '';

  return `MATCH (p:PhoneNumber {msisdn: '${safeMsisdn}'})
MATCH (p)-[:INITIATED|TARGET]-(ce:CommunicationEvent)
WHERE ce.event_id IS NOT NULL
  AND toUpper(coalesce(ce.type, '')) STARTS WITH 'CALL-'
  ${ceDirFilter}
  ${ceDateFilter}
WITH p, ce
OPTIONAL MATCH (src:PhoneNumber)-[:INITIATED]->(ce)
WITH p, ce, collect(DISTINCT src.msisdn) AS initiated_numbers
OPTIONAL MATCH (ce)-[:TARGET]->(dst:PhoneNumber)
WITH p, ce, initiated_numbers, collect(DISTINCT dst.msisdn) AS target_numbers
OPTIONAL MATCH (ce)-[:USED_DEVICE]->(dev:Device)
WITH
  p,
  ce,
  initiated_numbers,
  target_numbers,
  collect(DISTINCT dev.imei) AS event_imeis
RETURN
  'communication' AS source,
  ce.event_id AS communication_event_id,
  NULL AS presence_event_id,
  ce.type AS event_type,
  replace(toString(ce.timestamp), ' 00:00:00 ', ' ') AS event_timestamp,
  ce.duration AS event_duration,
  [n IN initiated_numbers WHERE n IS NOT NULL] AS initiated_numbers,
  [n IN target_numbers WHERE n IS NOT NULL] AS target_numbers,
  [n IN (initiated_numbers + target_numbers) WHERE n IS NOT NULL AND n <> p.msisdn] AS counterpart_numbers,
  [i IN event_imeis WHERE i IS NOT NULL] AS event_imeis,
  NULL AS cell_id
UNION ALL
MATCH (p:PhoneNumber {msisdn: '${safeMsisdn}'})-[:SEEN_AT]-(pe:PresenceEvent)-[:AT_LOCATION]-(loc:Location)
WHERE pe.event_id IS NOT NULL
  AND toUpper(coalesce(pe.type, '')) STARTS WITH 'CALL-'
  ${peDirFilter}
  ${peDateFilter}
RETURN
  'presence' AS source,
  NULL AS communication_event_id,
  pe.event_id AS presence_event_id,
  pe.type AS event_type,
  replace(toString(coalesce(pe.timestamp, pe.time_stamp)), ' 00:00:00 ', ' ') AS event_timestamp,
  pe.duration AS event_duration,
  [] AS initiated_numbers,
  [] AS target_numbers,
  [] AS counterpart_numbers,
  [] AS event_imeis,
  loc.cell_id AS cell_id
ORDER BY event_timestamp ASC
LIMIT 300`;
}

function detectReceivedCallsOnDateFollowUpIntent(
  userQuery: string,
  history: ConversationTurn[],
): { msisdn: string; date: string } | null {
  const q = userQuery.toLowerCase();
  const asksCalls = /\bcall\b|\bcalls\b|\bcall activity\b/.test(q);
  const asksReceived = /\breceived\b|\bincoming\b/.test(q);
  if (!asksCalls || !asksReceived) return null;

  const explicitMsisdn = extractMsisdn(userQuery);
  const msisdn = explicitMsisdn || extractLatestMsisdnFromHistory(history);
  if (!msisdn) return null;

  const explicitDate = extractIsoDate(userQuery);
  const sameDateRef = hasSameDateReference(userQuery);
  const date = explicitDate || (sameDateRef ? extractLatestDateFromHistory(history) : null);
  if (!date) return null;

  return { msisdn, date };
}

function detectEventsOnSameDateFollowUpIntent(
  userQuery: string,
  history: ConversationTurn[],
): { msisdn: string; date: string } | null {
  const q = userQuery.toLowerCase();
  const asksEvents = /\bevent\b|\bevents\b|\bactivity\b/.test(q);
  if (!asksEvents) return null;

  const explicitMsisdn = extractMsisdn(userQuery);
  const msisdn = explicitMsisdn || extractLatestMsisdnFromHistory(history);
  if (!msisdn) return null;

  const explicitDate = extractIsoDate(userQuery);
  const sameDateRef = hasSameDateReference(userQuery);
  const date =
    explicitDate ||
    (sameDateRef ? extractLatestDateFromHistory(history) : null);
  if (!date) return null;

  return { msisdn, date };
}

function detectUnifiedActivityIntent(
  userQuery: string,
  history: ConversationTurn[],
): { msisdn: string; date?: string } | null {
  const q = userQuery.toLowerCase();
  const asksActivity = /\bactivity\b|\bactivities\b|\bevents\b|\bevent\b/.test(q);
  if (!asksActivity) return null;

  // Let more specific intents handle this.
  if (/\bcall activity\b|\bcalls\b|\breceived\b|\bincoming\b|\boutgoing\b/.test(q)) {
    return null;
  }
  if (/\bcell\b|\btower\b|\blocation\b/.test(q)) {
    return null;
  }

  const explicitMsisdn = extractMsisdn(userQuery);
  const msisdn = explicitMsisdn || extractLatestMsisdnFromHistory(history);
  if (!msisdn) return null;

  const explicitDate = extractIsoDate(userQuery);
  const sameDateRef = hasSameDateReference(userQuery);
  const date =
    explicitDate ||
    (sameDateRef ? extractLatestDateFromHistory(history) : null) ||
    undefined;

  return { msisdn, date };
}

function buildUnifiedActivityMergeQuery(msisdn: string, date?: string): string {
  const safeMsisdn = escapeCypherLiteral(msisdn);
  const safeDate = date ? escapeCypherLiteral(date) : '';
  const dateSerial = date ? isoDateToExcelSerial(date) : null;

  const ceDateFilter = date
    ? `AND toString(ce.timestamp) STARTS WITH '${safeDate}'`
    : '';
  const peDateFilter = date
    ? `AND (
  toString(coalesce(pe.timestamp, pe.time_stamp)) STARTS WITH '${safeDate}'
  ${dateSerial ? `OR toString(coalesce(pe.timestamp, pe.time_stamp)) STARTS WITH '${dateSerial}'` : ''}
)`
    : '';

  return `MATCH (p:PhoneNumber {msisdn: '${safeMsisdn}'})
OPTIONAL MATCH (p)-[:INITIATED|TARGET]-(ce:CommunicationEvent)
WHERE ce.event_id IS NOT NULL
  ${ceDateFilter}
OPTIONAL MATCH (ce)-[:INITIATED|TARGET]-(other:PhoneNumber)
WHERE other.msisdn <> p.msisdn
WITH p, ce, collect(DISTINCT other.msisdn) AS ce_counterparts
WITH p, collect(DISTINCT {
  source: 'communication',
  event_id: ce.event_id,
  raw_type: ce.type,
  norm_type: toUpper(replace(coalesce(ce.type, ''), ' ROAMING', '')),
  ts_norm: replace(toString(ce.timestamp), ' 00:00:00 ', ' '),
  tod: right(replace(toString(ce.timestamp), ' 00:00:00 ', ' '), 8),
  duration: ce.duration,
  counterpart_numbers: ce_counterparts
}) AS ce_rows
OPTIONAL MATCH (p)-[:SEEN_AT]-(pe:PresenceEvent)-[:AT_LOCATION]-(loc:Location)
WHERE pe.event_id IS NOT NULL
  ${peDateFilter}
WITH ce_rows, collect(DISTINCT {
  source: 'presence',
  event_id: pe.event_id,
  raw_type: pe.type,
  norm_type: toUpper(replace(coalesce(pe.type, ''), ' ROAMING', '')),
  ts_norm: replace(toString(coalesce(pe.timestamp, pe.time_stamp)), ' 00:00:00 ', ' '),
  tod: right(replace(toString(coalesce(pe.timestamp, pe.time_stamp)), ' 00:00:00 ', ' '), 8),
  duration: pe.duration,
  cell_id: loc.cell_id
}) AS pe_rows
WITH ce_rows, pe_rows,
  [c IN ce_rows | c + {matched: [p IN pe_rows WHERE p.norm_type = c.norm_type AND p.tod = c.tod][0]}] AS paired
WITH ce_rows, pe_rows, paired,
  [p IN pe_rows WHERE size([c IN ce_rows WHERE c.norm_type = p.norm_type AND c.tod = p.tod]) = 0] AS pe_only
WITH
  [x IN paired | {
    event_type: x.raw_type,
    event_timestamp: x.ts_norm,
    event_duration: x.duration,
    communication_event_id: x.event_id,
    counterpart_numbers: coalesce(x.counterpart_numbers, []),
    presence_event_id: CASE WHEN x.matched IS NULL THEN NULL ELSE x.matched.event_id END,
    presence_timestamp: CASE WHEN x.matched IS NULL THEN NULL ELSE x.matched.ts_norm END,
    cell_id: CASE WHEN x.matched IS NULL THEN NULL ELSE x.matched.cell_id END,
    merged_with_presence: x.matched IS NOT NULL
  }] +
  [p IN pe_only | {
    event_type: p.raw_type,
    event_timestamp: p.ts_norm,
    event_duration: p.duration,
    communication_event_id: NULL,
    counterpart_numbers: [],
    presence_event_id: p.event_id,
    presence_timestamp: p.ts_norm,
    cell_id: p.cell_id,
    merged_with_presence: false
  }] AS unified
UNWIND unified AS ev
RETURN ev.event_type AS event_type, ev.event_timestamp AS event_timestamp, ev.event_duration AS event_duration, ev.communication_event_id AS communication_event_id, ev.presence_event_id AS presence_event_id, ev.cell_id AS cell_id, ev.counterpart_numbers AS counterpart_numbers, ev.merged_with_presence AS merged_with_presence, ev.presence_timestamp AS presence_timestamp
ORDER BY ev.event_timestamp ASC
LIMIT 300`;
}

function buildEventsOnDateQuery(msisdn: string, date: string): string {
  const safeMsisdn = escapeCypherLiteral(msisdn);
  const safeDate = escapeCypherLiteral(date);
  return `MATCH (p:PhoneNumber {msisdn: '${safeMsisdn}'})-[:INITIATED|TARGET]-(ce:CommunicationEvent)
WHERE toString(ce.timestamp) STARTS WITH '${safeDate}'
  AND ce.type IS NOT NULL
OPTIONAL MATCH (src:PhoneNumber)-[:INITIATED]->(ce)
OPTIONAL MATCH (ce)-[:TARGET]->(dst:PhoneNumber)
OPTIONAL MATCH (ce)-[:USED_DEVICE]->(dev:Device)
WITH p, ce,
  [n IN collect(DISTINCT src.msisdn) WHERE n IS NOT NULL] AS initiated_numbers,
  [n IN collect(DISTINCT dst.msisdn) WHERE n IS NOT NULL] AS target_numbers,
  [i IN collect(DISTINCT dev.imei) WHERE i IS NOT NULL] AS event_imeis
WITH p, ce, initiated_numbers, target_numbers, event_imeis,
  [n IN (initiated_numbers + target_numbers) WHERE n <> p.msisdn] AS counterpart_numbers
RETURN ce.event_id AS event_id, ce.type AS event_type, ce.timestamp AS event_timestamp, ce.duration AS event_duration, initiated_numbers, target_numbers, counterpart_numbers, event_imeis
ORDER BY ce.timestamp ASC
LIMIT 200`;
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

async function runCypher(
  cypher: string,
  includeGraph = false,
): Promise<{
  records: Record<string, unknown>[];
  graph?: GraphPayload;
  executedCypher: string;
}> {
  const driver = getDriver();
  const session = driver.session();
  try {
    const mapResultRecords = (
      result: {
        records: Array<{
          keys: PropertyKey[];
          get: (key: PropertyKey) => unknown;
        }>;
      },
    ) =>
      result.records.map((record) => {
        const obj = serializeNeo4jRecord({
          keys: record.keys.map((k) => String(k)),
          get: (key: string) => record.get(key),
        });
        return normalizeTemporalFields(obj as Record<string, unknown>);
      });

    try {
      const result = await session.run(cypher);
      const records = mapResultRecords(result);
      const graph = includeGraph ? extractGraphFromRecords(records) : undefined;
      return { records, graph, executedCypher: cypher };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isTemporalParseError(message)) throw err;

      const repairedCypher = repairCypherTemporalLiterals(cypher);
      if (repairedCypher === cypher) throw err;

      const repairedResult = await session.run(repairedCypher);
      const records = mapResultRecords(repairedResult);
      const graph = includeGraph ? extractGraphFromRecords(records) : undefined;
      return { records, graph, executedCypher: repairedCypher };
    }
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
      'You are a senior investigative analyst. You receive multiple model opinions and the underlying graph query and results. Your job is to synthesize them into ONE clear, concise answer for a police officer.\n\nVERY IMPORTANT OUTPUT RULES:\n- Start with a direct answer in 2–4 short sentences.\n- When the user explicitly asks to “show data”, prefer **tables or bullet-point lists of records** instead of long narrative reports.\n- Format output in valid Markdown for UI rendering.\n- When showing a table, use proper GitHub-style markdown table syntax with a header separator row.\n- If the user asks for a flow chart or diagram, output Mermaid inside a fenced block: ```mermaid ... ```.\n- Avoid email-style headers (no To:, From:, Subject:, dates, or greetings like “Hello Officer”).\n- Prefer neutral section headings like “Facts from the Data” only when useful.\n- Prefer statements that are clearly supported by the data.\n- If records include path fields (p, hop_count, relationship_chain), treat that as concrete hidden-link evidence.\n- If records include initiated_numbers/target_numbers/counterpart_numbers/event_imeis, use them explicitly in reasoning.\n- If records include a_timestamps/b_timestamps (co-location evidence), surface those times explicitly.\n- If records include temporal_overlap_count/overlap_evidence/matched_time_of_day, explicitly assess probable co-presence strength from those fields.\n- Do NOT claim caller/callee/counterpart or timestamps are unavailable when corresponding fields are present and non-empty in records.\n- If records are non-empty for connectivity queries, do NOT conclude "no relationship".\n- If models disagree, call out the uncertainty and explain which parts are certain vs speculative.\n- Always distinguish facts (directly in the data) from hypotheses.\n- If the data is insufficient for a conclusion, say so and optionally suggest follow-up queries.',
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
  const eventsOnDateIntent = detectEventsOnSameDateFollowUpIntent(
    userQuery,
    options.history ?? [],
  );
  const eventLocationIntent = detectEventLocationIntent(userQuery);
  const unifiedActivityIntent = detectUnifiedActivityIntent(
    userQuery,
    options.history ?? [],
  );
  const eventsAtCellIntent = detectPhoneEventsAtCellIntent(userQuery);
  const coLocationFollowUpIntent = detectCoLocationTimeFollowUpIntent(
    userQuery,
    options.history ?? [],
  );
  const coLocationIntent = detectCoLocationIntent(userQuery);
  const receivedFollowUpIntent = detectReceivedCallsOnDateFollowUpIntent(
    userQuery,
    options.history ?? [],
  );
  const callActivityIntent = detectCallActivityIntent(
    userQuery,
    options.history ?? [],
  );
  const phonePhoneIntent = detectPhoneToPhoneLinkIntent(userQuery);
  const pathIntent = detectPhoneToLocationPathIntent(userQuery);
  const imeiIntent = detectPhoneToImeiIntent(userQuery);
  const phoneIpIntent = detectPhoneToIpIntent(userQuery);
  const ipEventIntent = detectIpToEventIntent(userQuery);
  const genericIntent = detectGenericComplexRelationshipIntent(userQuery);
  let candidateQueries: QueryCandidate[] = [];
  if (eventLocationIntent) {
    candidateQueries = [
      {
        name: 'Event location from both sources (CommunicationEvent + PresenceEvent)',
        strategy: 'intermediate_path',
        cypher: buildEventLocationFromBothSourcesQuery(eventLocationIntent.eventId),
      },
    ];
    await emit({
      stage: 'planning_query',
      message: `Detected event-location intent for event ${eventLocationIntent.eventId}. Querying both CommunicationEvent and PresenceEvent evidence paths.`,
    });
  } else if (unifiedActivityIntent) {
    candidateQueries = [
      {
        name: 'Unified activity merge (communication + presence)',
        strategy: 'intermediate_path',
        cypher: buildUnifiedActivityMergeQuery(
          unifiedActivityIntent.msisdn,
          unifiedActivityIntent.date,
        ),
      },
    ];
    await emit({
      stage: 'planning_query',
      message: `Detected unified activity intent for ${unifiedActivityIntent.msisdn}${unifiedActivityIntent.date ? ` on ${unifiedActivityIntent.date}` : ''}. Merging CommunicationEvent and PresenceEvent by normalized timestamp/type.`,
    });
  } else if (eventsAtCellIntent) {
    candidateQueries = [
      {
        name: 'Phone events at cell via timestamp correlation',
        strategy: 'intermediate_path',
        cypher: buildPhoneEventsAtCellQuery(
          eventsAtCellIntent.msisdn,
          eventsAtCellIntent.cellId,
        ),
      },
    ];
    await emit({
      stage: 'planning_query',
      message: `Detected events-at-cell intent for ${eventsAtCellIntent.msisdn} at ${eventsAtCellIntent.cellId}. Correlating CommunicationEvent and PresenceEvent timestamps.`,
    });
  } else if (coLocationFollowUpIntent) {
    candidateQueries = buildCoLocationCandidates(
      coLocationFollowUpIntent.a,
      coLocationFollowUpIntent.b,
      coLocationFollowUpIntent.cellId,
    );
    await emit({
      stage: 'planning_query',
      message: `Resolved follow-up co-location timing intent for ${coLocationFollowUpIntent.a} and ${coLocationFollowUpIntent.b}${coLocationFollowUpIntent.cellId ? ` at cell ${coLocationFollowUpIntent.cellId}` : ''}. Fetching PresenceEvent timestamps.`,
    });
  } else if (coLocationIntent) {
    candidateQueries = buildCoLocationCandidates(
      coLocationIntent.a,
      coLocationIntent.b,
      coLocationIntent.cellId,
    );
    await emit({
      stage: 'planning_query',
      message: `Detected co-location intent for ${coLocationIntent.a} and ${coLocationIntent.b}. Using PresenceEvent -> Location evidence with timestamps.`,
    });
  } else if (eventsOnDateIntent) {
    candidateQueries = [
      {
        name: 'Events on same date (follow-up deterministic)',
        strategy: 'intermediate_path',
        cypher: buildEventsOnDateQuery(
          eventsOnDateIntent.msisdn,
          eventsOnDateIntent.date,
        ),
      },
    ];
    await emit({
      stage: 'planning_query',
      message: `Resolved follow-up context: events for ${eventsOnDateIntent.msisdn} on ${eventsOnDateIntent.date}. Fetching communication events with linked parties and device evidence.`,
    });
  } else if (receivedFollowUpIntent) {
    candidateQueries = [
      {
        name: 'Received call activity (merged communication + presence)',
        strategy: 'intermediate_path',
        cypher: buildCallActivityMergedQuery(
          receivedFollowUpIntent.msisdn,
          receivedFollowUpIntent.date,
          'received',
        ),
      },
    ];
    await emit({
      stage: 'planning_query',
      message: `Resolved follow-up context: received calls for ${receivedFollowUpIntent.msisdn} on ${receivedFollowUpIntent.date}. Using safe timestamp-prefix filtering.`,
    });
  } else if (callActivityIntent) {
    candidateQueries = [
      {
        name: 'Call activity (merged communication + presence)',
        strategy: 'intermediate_path',
        cypher: buildCallActivityMergedQuery(
          callActivityIntent.msisdn,
          callActivityIntent.date,
          callActivityIntent.direction,
        ),
      },
    ];
    await emit({
      stage: 'planning_query',
      message: `Detected call activity intent for ${callActivityIntent.msisdn}${callActivityIntent.date ? ` on ${callActivityIntent.date}` : ''}. Fetching and merging CommunicationEvent + PresenceEvent evidence.`,
    });
  } else if (phonePhoneIntent) {
    candidateQueries = buildPhoneToPhoneLinkCandidates(
      phonePhoneIntent.a,
      phonePhoneIntent.b,
    );
    await emit({
      stage: 'planning_query',
      message: `Detected phone-to-phone hidden-link intent between ${phonePhoneIntent.a} and ${phonePhoneIntent.b}. Running multi-strategy path and shared-evidence queries.`,
    });
  } else if (pathIntent) {
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
      const result = await runCypher(
        candidate.cypher,
        Boolean(options.includeGraph),
      );
      executions.push({
        candidate,
        executedCypher: result.executedCypher,
        records: result.records,
        graph: result.graph,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      executions.push({
        candidate,
        executedCypher: candidate.cypher,
        records: [],
        error: message,
      });
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
  const cypher = evaluation.best.executedCypher || evaluation.best.candidate.cypher;
  const records = evaluation.best.records;
  const graph = evaluation.best.graph;
  const queryEvaluation = `Selected strategy: ${evaluation.best.candidate.name} (${evaluation.best.candidate.strategy}). ${evaluation.summary}`;
  await emit({
    stage: 'data_fetched',
    message: `Selected best strategy and fetched ${records.length} record(s) from the graph.`,
    meta: {
      recordCount: records.length,
      preview: records.slice(0, 3),
      graphMeta: graph?.meta,
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
    graph,
    modelResponses,
    candidateQueries: candidateQueries.map((q) => q.cypher),
    queryEvaluation,
  };
}
