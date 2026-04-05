export type GraphNode = {
  id: string;
  label: string;
  title: string;
  props: Record<string, unknown>;
};

export type GraphEdge = {
  id: string;
  from: string;
  to: string;
  type: string;
  props: Record<string, unknown>;
};

export type GraphMeta = {
  nodeCount: number;
  edgeCount: number;
  truncated: boolean;
};

export type GraphPayload = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta: GraphMeta;
};

type SerializedNode = {
  _type: 'node';
  id?: string;
  labels?: string[];
  properties?: Record<string, unknown>;
};

type SerializedRelationship = {
  _type: 'relationship';
  id?: string;
  relationshipType?: string;
  startNodeId?: string;
  endNodeId?: string;
  properties?: Record<string, unknown>;
};

type SerializedPath = {
  _type: 'path';
  nodes?: SerializedNode[];
  relationships?: SerializedRelationship[];
  length?: number;
};

type ExtractOptions = {
  maxNodes?: number;
  maxEdges?: number;
};

const DEFAULT_MAX_NODES = 80;
const DEFAULT_MAX_EDGES = 120;

const PRIMARY_KEY_BY_LABEL: Record<string, string> = {
  PhoneNumber: 'msisdn',
  BankAccount: 'account_number',
  CommunicationEvent: 'event_id',
  Device: 'imei',
  FinancialTransaction: 'txn_id',
  InternetSession: 'session_id',
  IPAddress: 'ip',
  Location: 'cell_id',
  PresenceEvent: 'event_id',
};

const SAFE_NODE_PROP_KEYS = new Set<string>([
  'msisdn',
  'account_number',
  'event_id',
  'imei',
  'txn_id',
  'session_id',
  'ip',
  'cell_id',
  'type',
  'timestamp',
  'time_stamp',
  'start_time',
  'end_time',
  'duration',
  'date',
  'credit',
  'debit',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function toIdString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();

  const obj = value as { toString?: () => string; toNumber?: () => number };
  if (typeof obj.toNumber === 'function') {
    try {
      const n = obj.toNumber();
      if (Number.isFinite(n)) return String(n);
    } catch {
      // noop
    }
  }
  if (typeof obj.toString === 'function') {
    try {
      const s = obj.toString();
      if (s && s !== '[object Object]') return s;
    } catch {
      // noop
    }
  }
  return null;
}

function serializeProps(
  props: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    out[k] = serializeNeo4jValue(v);
  }
  return out;
}

export function serializeNeo4jValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map(serializeNeo4jValue);
  }

  if (!isObject(value)) return value;

  // Neo4j Integer-like object
  if ('low' in value && 'high' in value && typeof (value as { toNumber?: unknown }).toNumber === 'function') {
    try {
      return (value as { toNumber: () => number }).toNumber();
    } catch {
      return (value as { toString?: () => string }).toString?.() ?? null;
    }
  }

  // Neo4j Node
  if ('labels' in value && 'properties' in value) {
    const node = value as {
      labels?: string[];
      properties?: Record<string, unknown>;
      identity?: unknown;
    };
    return {
      _type: 'node',
      id: toIdString(node.identity ?? null) ?? undefined,
      labels: Array.isArray(node.labels) ? node.labels : [],
      properties: serializeProps(node.properties ?? {}),
    } satisfies SerializedNode;
  }

  // Neo4j Relationship
  if ('type' in value && 'properties' in value && 'start' in value && 'end' in value) {
    const rel = value as {
      identity?: unknown;
      type?: string;
      properties?: Record<string, unknown>;
      start?: unknown;
      end?: unknown;
    };
    return {
      _type: 'relationship',
      id: toIdString(rel.identity ?? null) ?? undefined,
      relationshipType: typeof rel.type === 'string' ? rel.type : 'RELATED_TO',
      startNodeId: toIdString(rel.start ?? null) ?? undefined,
      endNodeId: toIdString(rel.end ?? null) ?? undefined,
      properties: serializeProps(rel.properties ?? {}),
    } satisfies SerializedRelationship;
  }

  // Neo4j Path
  if ('segments' in value && Array.isArray((value as { segments?: unknown[] }).segments)) {
    const p = value as {
      start?: unknown;
      end?: unknown;
      segments: Array<{
        start?: unknown;
        end?: unknown;
        relationship?: unknown;
      }>;
    };
    const nodes: SerializedNode[] = [];
    const relationships: SerializedRelationship[] = [];

    const startSerialized = serializeNeo4jValue(p.start);
    if (isObject(startSerialized) && startSerialized._type === 'node') {
      nodes.push(startSerialized as SerializedNode);
    }

    for (const seg of p.segments) {
      const relSerialized = serializeNeo4jValue(seg.relationship);
      if (isObject(relSerialized) && relSerialized._type === 'relationship') {
        relationships.push(relSerialized as SerializedRelationship);
      }
      const endSerialized = serializeNeo4jValue(seg.end);
      if (isObject(endSerialized) && endSerialized._type === 'node') {
        nodes.push(endSerialized as SerializedNode);
      }
    }

    if (nodes.length === 0) {
      const endSerialized = serializeNeo4jValue(p.end);
      if (isObject(endSerialized) && endSerialized._type === 'node') {
        nodes.push(endSerialized as SerializedNode);
      }
    }

    return {
      _type: 'path',
      nodes,
      relationships,
      length: relationships.length,
    } satisfies SerializedPath;
  }

  const plain: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    plain[k] = serializeNeo4jValue(v);
  }
  return plain;
}

export function serializeNeo4jRecord(record: {
  keys: string[];
  get: (key: string) => unknown;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of record.keys) {
    out[key] = serializeNeo4jValue(record.get(key));
  }
  return out;
}

function pickDisplayProps(
  label: string,
  props: Record<string, unknown>,
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  const primary = PRIMARY_KEY_BY_LABEL[label];
  if (primary && primary in props) {
    picked[primary] = props[primary];
  }
  for (const [k, v] of Object.entries(props)) {
    if (k === primary) continue;
    if (!SAFE_NODE_PROP_KEYS.has(k)) continue;
    picked[k] = v;
    if (Object.keys(picked).length >= 6) break;
  }
  return picked;
}

function getNodeTitle(label: string, props: Record<string, unknown>, fallbackId: string): string {
  const primary = PRIMARY_KEY_BY_LABEL[label];
  const value = primary ? props[primary] : undefined;
  const shown = value === undefined || value === null || value === '' ? fallbackId : String(value);
  return `${label}\n${shown}`;
}

export function extractGraphFromRecords(
  records: Record<string, unknown>[],
  options: ExtractOptions = {},
): GraphPayload {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const maxEdges = options.maxEdges ?? DEFAULT_MAX_EDGES;
  const nodeMap = new Map<string, GraphNode>();
  const edgeMap = new Map<string, GraphEdge>();
  let truncated = false;
  const seen = new WeakSet<object>();

  const addNode = (node: SerializedNode) => {
    const label = Array.isArray(node.labels) && node.labels.length ? String(node.labels[0]) : 'Entity';
    const props = isObject(node.properties) ? node.properties : {};
    const fallbackId = node.id || `${label}:${Object.values(props)[0] ?? nodeMap.size + 1}`;
    const id = node.id || fallbackId;
    if (nodeMap.has(id)) return;
    if (nodeMap.size >= maxNodes) {
      truncated = true;
      return;
    }
    nodeMap.set(id, {
      id,
      label,
      title: getNodeTitle(label, props, id),
      props: pickDisplayProps(label, props),
    });
  };

  const addEdge = (
    rel: SerializedRelationship,
    fallbackFrom?: string,
    fallbackTo?: string,
  ) => {
    const from = rel.startNodeId || fallbackFrom;
    const to = rel.endNodeId || fallbackTo;
    if (!from || !to) return;

    const type =
      typeof rel.relationshipType === 'string' && rel.relationshipType
        ? rel.relationshipType
        : 'RELATED_TO';
    const id = rel.id || `${from}|${type}|${to}`;
    if (edgeMap.has(id)) return;
    if (edgeMap.size >= maxEdges) {
      truncated = true;
      return;
    }
    edgeMap.set(id, {
      id,
      from,
      to,
      type,
      props: isObject(rel.properties) ? rel.properties : {},
    });
  };

  const walk = (value: unknown) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!isObject(value)) return;
    if (seen.has(value)) return;
    seen.add(value);

    if (value._type === 'node') {
      addNode(value as SerializedNode);
      return;
    }

    if (value._type === 'relationship') {
      addEdge(value as SerializedRelationship);
      return;
    }

    if (value._type === 'path') {
      const p = value as SerializedPath;
      const pathNodes = Array.isArray(p.nodes) ? p.nodes : [];
      const pathRels = Array.isArray(p.relationships) ? p.relationships : [];
      pathNodes.forEach(addNode);
      pathRels.forEach((rel, idx) => {
        const fromFallback = pathNodes[idx]?.id;
        const toFallback = pathNodes[idx + 1]?.id;
        addEdge(rel, fromFallback, toFallback);
      });
      return;
    }

    Object.values(value).forEach(walk);
  };

  records.forEach((record) => walk(record));

  return {
    nodes: Array.from(nodeMap.values()),
    edges: Array.from(edgeMap.values()),
    meta: {
      nodeCount: nodeMap.size,
      edgeCount: edgeMap.size,
      truncated,
    },
  };
}
