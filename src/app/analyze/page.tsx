'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Search,
  Shield,
  User,
  FileText,
  ArrowRight,
  Activity,
  TerminalSquare,
  Database,
  AlertTriangle,
  Loader2,
  CheckCircle2,
  Sparkles,
  Download,
  BarChart3,
  Save,
} from 'lucide-react';
import MarkdownMessage from '@/components/MarkdownMessage';
import { extractGraphFromRecords, GraphPayload } from '@/lib/graphPayload';
import { graphToMermaidFlowchart } from '@/lib/graphFlowchart';
import {
  IntentConfidence,
  InvestigationIntent,
  INTENT_REASON_TAGS,
  INVESTIGATION_INTENTS,
} from '@/lib/investigationIntent';

type LLMOpinion = {
  provider: string;
  model: string;
  content: string;
};

type ExportFormat = 'csv' | 'xlsx' | 'pdf';
type ExportMode = 'records' | 'detailed';

type ExportRequestInfo = {
  format: ExportFormat;
  mode: ExportMode;
  baseName: string;
  label: string;
  query?: string;
  explanation?: string;
  cypher?: string;
};

type Message = {
  id: string;
  role: 'user' | 'system';
  content: string;
  timestamp: string;
  createdAt?: string;
  records?: Record<string, unknown>[];
  graph?: GraphPayload;
  cypher?: string;
  candidateQueries?: string[];
  queryEvaluation?: string;
  modelResponses?: LLMOpinion[];
  error?: boolean;
  exportRequest?: ExportRequestInfo;
  predictedIntent?: InvestigationIntent;
  intentConfidence?: IntentConfidence;
  strategyUsed?: string;
  trueIntent?: InvestigationIntent;
  intentReasonTag?: string;
  intentNotes?: string;
  reviewedBy?: string;
  reviewedAt?: string;
};

type ProgressStage =
  | 'started'
  | 'planning_query'
  | 'query_ready'
  | 'fetching_data'
  | 'data_fetched'
  | 'calling_models'
  | 'model_done'
  | 'synthesizing'
  | 'completed';

type AgentProgressEvent = {
  stage: ProgressStage;
  message: string;
  meta?: Record<string, unknown>;
};

type ProgressStepKey = 'plan' | 'fetch' | 'models' | 'synthesize';
type ProgressStepStatus = 'pending' | 'active' | 'done';

type ProgressStep = {
  key: ProgressStepKey;
  label: string;
  status: ProgressStepStatus;
};

type OperationState = {
  title: string;
  steps: ProgressStep[];
  logs: string[];
  recordPreview?: Record<string, unknown>[];
  modelsDone: number;
  totalModels: number;
};

type StreamFinalPayload = {
  success: boolean;
  finalAnswer: string;
  cypher?: string;
  candidateQueries?: string[];
  queryEvaluation?: string;
  records?: Record<string, unknown>[];
  graph?: GraphPayload;
  modelResponses?: LLMOpinion[];
  predictedIntent?: InvestigationIntent;
  intentConfidence?: IntentConfidence;
  strategyUsed?: string;
};

type ConfusionMatrixPayload = {
  success: boolean;
  labels: InvestigationIntent[];
  matrix: Array<{
    trueIntent: InvestigationIntent;
    predictedIntent: InvestigationIntent;
    count: number;
  }>;
  stats: Array<{
    intent: InvestigationIntent;
    support: number;
    predictedCount: number;
    truePositive: number;
    precision: number;
    recall: number;
    f1: number;
  }>;
  macro: { precision: number; recall: number; f1: number };
  micro: { precision: number; recall: number; f1: number };
  totalLabeled: number;
  topConfusions: Array<{
    trueIntent: InvestigationIntent;
    predictedIntent: InvestigationIntent;
    count: number;
  }>;
  unresolvedLabelCount: number;
};

function getTimestamp() {
  return new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function getMessageCreatedAt() {
  return new Date().toISOString();
}

function createMessageId(prefix = 'msg'): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getWelcomeMessage(): Message {
  return {
    id: '1',
    role: 'system',
    content:
      'System Initialized. Neo4j graph database connected securely. Enter a Cypher query or a natural language investigation query.',
    timestamp: getTimestamp(),
    createdAt: getMessageCreatedAt(),
  };
}

function createInitialOperation(kind: 'agent' | 'cypher'): OperationState {
  return {
    title:
      kind === 'agent'
        ? 'Investigation pipeline is running'
        : 'Executing direct Cypher query',
    steps:
      kind === 'agent'
        ? [
            { key: 'plan', label: 'Agent planning query', status: 'active' },
            { key: 'fetch', label: 'Fetching graph data', status: 'pending' },
            {
              key: 'models',
              label: 'Calling analysis models',
              status: 'pending',
            },
            {
              key: 'synthesize',
              label: 'Generating final response',
              status: 'pending',
            },
          ]
        : [
            { key: 'plan', label: 'Validating query', status: 'active' },
            { key: 'fetch', label: 'Fetching graph data', status: 'pending' },
            {
              key: 'models',
              label: 'Preparing result format',
              status: 'pending',
            },
            {
              key: 'synthesize',
              label: 'Publishing response',
              status: 'pending',
            },
          ],
    logs: [
      kind === 'agent'
        ? 'Agent accepted the task.'
        : 'Cypher query accepted for execution.',
    ],
    modelsDone: 0,
    totalModels: kind === 'agent' ? 2 : 1,
  };
}

function updateStepStatus(
  steps: ProgressStep[],
  key: ProgressStepKey,
  status: ProgressStepStatus,
): ProgressStep[] {
  return steps.map((step) => (step.key === key ? { ...step, status } : step));
}

function appendLog(logs: string[], entry: string): string[] {
  const next = [...logs, entry];
  return next.slice(-7);
}

function applyProgressEvent(
  current: OperationState,
  event: AgentProgressEvent,
): OperationState {
  const next = {
    ...current,
    steps: [...current.steps],
    logs: [...current.logs],
  };

  switch (event.stage) {
    case 'started': {
      next.steps = updateStepStatus(next.steps, 'plan', 'active');
      break;
    }
    case 'planning_query': {
      next.steps = updateStepStatus(next.steps, 'plan', 'active');
      break;
    }
    case 'query_ready': {
      next.steps = updateStepStatus(next.steps, 'plan', 'done');
      next.steps = updateStepStatus(next.steps, 'fetch', 'active');
      break;
    }
    case 'fetching_data': {
      next.steps = updateStepStatus(next.steps, 'fetch', 'active');
      break;
    }
    case 'data_fetched': {
      next.steps = updateStepStatus(next.steps, 'fetch', 'done');
      next.steps = updateStepStatus(next.steps, 'models', 'active');
      if (Array.isArray(event.meta?.preview)) {
        next.recordPreview = event.meta?.preview as Record<string, unknown>[];
      }
      break;
    }
    case 'calling_models': {
      next.steps = updateStepStatus(next.steps, 'models', 'active');
      break;
    }
    case 'model_done': {
      const doneCount = next.modelsDone + 1;
      next.modelsDone = doneCount;
      if (doneCount >= next.totalModels) {
        next.steps = updateStepStatus(next.steps, 'models', 'done');
        next.steps = updateStepStatus(next.steps, 'synthesize', 'active');
      }
      break;
    }
    case 'synthesizing': {
      next.steps = updateStepStatus(next.steps, 'models', 'done');
      next.steps = updateStepStatus(next.steps, 'synthesize', 'active');
      break;
    }
    case 'completed': {
      next.steps = next.steps.map((step) => ({ ...step, status: 'done' }));
      break;
    }
  }

  next.logs = appendLog(next.logs, event.message);
  return next;
}

/**
 * Format Neo4j query results into a readable string.
 */
function formatRecords(records: Record<string, unknown>[]): string {
  if (records.length === 0)
    return 'Query executed successfully. No records returned.';

  const lines: string[] = [`${records.length} record(s) returned:\n`];

  records.forEach((record, idx) => {
    lines.push(`── Record ${idx + 1} ──`);
    for (const [key, val] of Object.entries(record)) {
      if (
        val &&
        typeof val === 'object' &&
        '_type' in (val as Record<string, unknown>)
      ) {
        const typed = val as {
          _type: string;
          labels?: string[];
          relationshipType?: string;
          properties: Record<string, unknown>;
        };
        if (typed._type === 'node') {
          lines.push(`  ${key}: (${typed.labels?.join(':')})`);
          for (const [pk, pv] of Object.entries(typed.properties)) {
            lines.push(`    ${pk}: ${JSON.stringify(pv)}`);
          }
        } else if (typed._type === 'relationship') {
          lines.push(`  ${key}: -[:${typed.relationshipType}]-`);
          for (const [pk, pv] of Object.entries(typed.properties)) {
            lines.push(`    ${pk}: ${JSON.stringify(pv)}`);
          }
        }
      } else {
        lines.push(`  ${key}: ${JSON.stringify(val)}`);
      }
    }
  });

  return lines.join('\n');
}

function getSuggestions(messages: Message[]): string[] {
  const suggestions: string[] = [];
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const lastSystem = [...messages].reverse().find((m) => m.role === 'system');

  if (lastSystem) {
    suggestions.push('Show the latest findings as a compact table.');
    suggestions.push(
      'Create a flowchart of entity relationships from this output.',
    );
  }

  if (lastUser?.content) {
    const q = lastUser.content;
    const numberMatch = q.match(/\b\d{8,15}\b/);
    if (numberMatch) {
      suggestions.push(
        `Trace all connected events for ${numberMatch[0]} in chronological order.`,
      );
    }

    if (/transaction|debit|credit|bank/i.test(q)) {
      suggestions.push(
        'Identify suspicious debit patterns above normal baseline.',
      );
    } else if (/phone|imei|ipdr|location/i.test(q)) {
      suggestions.push('Highlight top 5 numbers by connection frequency.');
    } else {
      suggestions.push(
        'Summarize key facts vs hypotheses from the last response.',
      );
    }
  }

  // suggestions.push('What should I investigate next based on this result?');

  return Array.from(new Set(suggestions)).slice(0, 3);
}

function buildFlowchartMarkdown(graph: GraphPayload): string {
  const mermaid = graphToMermaidFlowchart(graph);
  return `\`\`\`mermaid\n${mermaid}\n\`\`\``;
}

function extractMsisdnFromCypher(cypher?: string): string | null {
  if (!cypher) return null;
  const m = cypher.match(/msisdn\s*:\s*'(\d{10,15})'/i);
  return m ? m[1] : null;
}

function inferGraphFromCallActivityRows(
  records: Record<string, unknown>[],
  cypher?: string,
): GraphPayload | null {
  if (!records.length) return null;
  const hasCallShape = records.some(
    (r) =>
      typeof r.event_id === 'string' &&
      typeof r.event_type === 'string' &&
      Array.isArray(r.counterpart_numbers),
  );
  if (!hasCallShape) return null;

  const subjectMsisdn = extractMsisdnFromCypher(cypher) || 'UNKNOWN';
  const nodes: GraphPayload['nodes'] = [];
  const edges: GraphPayload['edges'] = [];
  const nodeMap = new Map<string, GraphPayload['nodes'][number]>();
  const edgeSet = new Set<string>();

  const addNode = (node: GraphPayload['nodes'][number]) => {
    if (!nodeMap.has(node.id)) {
      nodeMap.set(node.id, node);
      nodes.push(node);
    }
  };

  const addEdge = (edge: GraphPayload['edges'][number]) => {
    const key = `${edge.from}|${edge.type}|${edge.to}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edges.push(edge);
  };

  const subjectId = `phone:${subjectMsisdn}`;
  addNode({
    id: subjectId,
    label: 'PhoneNumber',
    title: `PhoneNumber\n${subjectMsisdn}`,
    props: { msisdn: subjectMsisdn },
  });

  for (const row of records) {
    const eventId = typeof row.event_id === 'string' ? row.event_id : '';
    const eventType =
      typeof row.event_type === 'string' ? row.event_type : 'CALL';
    if (!eventId) continue;

    const eventNodeId = `event:${eventId}`;
    addNode({
      id: eventNodeId,
      label: 'CommunicationEvent',
      title: `CommunicationEvent\n${eventId}`,
      props: {
        event_id: eventId,
        type: eventType,
        timestamp:
          typeof row.event_timestamp === 'string'
            ? row.event_timestamp
            : undefined,
        duration:
          typeof row.event_duration === 'number'
            ? row.event_duration
            : undefined,
      },
    });

    addEdge({
      id: `${subjectId}|${eventType}|${eventNodeId}`,
      from: subjectId,
      to: eventNodeId,
      type: eventType,
      props: {},
    });

    const counterparts = Array.isArray(row.counterpart_numbers)
      ? row.counterpart_numbers
      : [];
    for (const cp of counterparts) {
      if (typeof cp !== 'string' || !cp.trim()) continue;
      const cpId = `phone:${cp}`;
      addNode({
        id: cpId,
        label: 'PhoneNumber',
        title: `PhoneNumber\n${cp}`,
        props: { msisdn: cp },
      });
      addEdge({
        id: `${eventNodeId}|COUNTERPART|${cpId}`,
        from: eventNodeId,
        to: cpId,
        type: 'COUNTERPART',
        props: {},
      });
    }
  }

  if (!nodes.length || !edges.length) return null;
  return {
    nodes,
    edges,
    meta: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      truncated: false,
    },
  };
}

function detectFlowchartOnlyRequest(query: string): boolean {
  const q = query.toLowerCase();
  if (!detectFlowchartRequest(query)) return false;
  return (
    q.includes('from this output') ||
    q.includes('from above') ||
    q.includes('from previous') ||
    q.includes('this output') ||
    q.includes('same output') ||
    q.includes('show flowchart') ||
    q.includes('create a flowchart') ||
    q.includes('draw a flowchart')
  );
}

function detectRequestedExportFormat(query: string): ExportFormat | null {
  const q = query.toLowerCase();
  if (!/(export|download|file|excel|xlsx|csv|pdf|sheet|report)/i.test(query)) {
    return null;
  }
  if (/\bexcel\b|\bxlsx\b|\bsheet\b/.test(q)) return 'xlsx';
  if (/\bcsv\b/.test(q)) return 'csv';
  if (/\bpdf\b|\breport\b/.test(q)) return 'pdf';
  return 'xlsx';
}

function detectExportMode(query: string): ExportMode {
  const q = query.toLowerCase();
  if (
    /\bonly records\b|\bjust records\b|\brecords only\b|\bonly data\b|\braw records\b/.test(
      q,
    )
  ) {
    return 'records';
  }

  if (
    /\bdetailed\b|\bdetail explanation\b|\bexplain\b|\breasoning\b|\banalysis\b|\binsight\b|\bwhy\b/.test(
      q,
    )
  ) {
    return 'detailed';
  }

  return 'records';
}

function detectFlowchartRequest(query: string): boolean {
  const q = query.toLowerCase();
  return /flow\s*chart|flowchart|diagram|visuali[sz]e|relationship graph|graph view|show graph|node graph|mermaid/.test(
    q,
  );
}

async function consumeSSE(
  res: Response,
  onEvent: (event: string, data: unknown) => void,
) {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('Stream reader is unavailable.');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const splitIndex = buffer.indexOf('\n\n');
      if (splitIndex === -1) break;

      const block = buffer.slice(0, splitIndex);
      buffer = buffer.slice(splitIndex + 2);

      let eventName = 'message';
      const dataLines: string[] = [];

      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trim());
        }
      }

      if (!dataLines.length) continue;

      try {
        onEvent(eventName, JSON.parse(dataLines.join('\n')));
      } catch {
        // Ignore malformed stream chunks.
      }
    }
  }
}

type CasePayload = {
  caseId: string;
  title: string;
};

type CaseSummary = {
  caseId: string;
  title: string;
  updatedAt: string;
  createdAt: string;
  lastMessagePreview: string;
};

function AnalyzePageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const caseParam = searchParams.get('case');

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isCaseLoading, setIsCaseLoading] = useState(false);
  const [activeCaseId, setActiveCaseId] = useState<string | null>(null);
  const [operationState, setOperationState] = useState<OperationState | null>(
    null,
  );
  const [showSuggestions, setShowSuggestions] = useState(true);
  const [showModelQuality, setShowModelQuality] = useState(false);
  const [matrixData, setMatrixData] = useState<ConfusionMatrixPayload | null>(
    null,
  );
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [labelIntentDraft, setLabelIntentDraft] = useState<
    Record<string, InvestigationIntent>
  >({});
  const [labelReasonDraft, setLabelReasonDraft] = useState<
    Record<string, string>
  >({});
  const [labelNotesDraft, setLabelNotesDraft] = useState<
    Record<string, string>
  >({});
  const [labelSaving, setLabelSaving] = useState<Record<string, boolean>>({});
  const [editReviewedLabel, setEditReviewedLabel] = useState<
    Record<string, boolean>
  >({});

  const chatEndRef = useRef<HTMLDivElement>(null);

  const createCaseIfMissing = async (): Promise<CasePayload> => {
    const res = await fetch('/api/cases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (!res.ok || !data.success || !data.case?.caseId) {
      throw new Error(data.error || 'Failed to create case.');
    }
    return {
      caseId: String(data.case.caseId),
      title: String(data.case.title ?? ''),
    };
  };

  const getLatestCase = async (): Promise<CaseSummary | null> => {
    const res = await fetch('/api/cases', { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok || !data.success || !Array.isArray(data.cases)) {
      return null;
    }
    const first = (data.cases as CaseSummary[])[0];
    return first ?? null;
  };

  const loadCaseMessages = async (caseId: string) => {
    const res = await fetch(
      `/api/cases/${encodeURIComponent(caseId)}/messages`,
      {
        cache: 'no-store',
      },
    );
    const data = await res.json();
    if (!res.ok || !data.success || !Array.isArray(data.messages)) {
      throw new Error(data.error || 'Failed to load case messages.');
    }

    const loaded = (data.messages as Message[]).map((msg) => ({
      ...msg,
      createdAt: msg.createdAt || getMessageCreatedAt(),
    }));

    const nextIntentDraft: Record<string, InvestigationIntent> = {};
    const nextReasonDraft: Record<string, string> = {};
    const nextNotesDraft: Record<string, string> = {};
    for (const msg of loaded) {
      if (msg.trueIntent) nextIntentDraft[msg.id] = msg.trueIntent;
      if (msg.intentReasonTag) nextReasonDraft[msg.id] = msg.intentReasonTag;
      if (msg.intentNotes) nextNotesDraft[msg.id] = msg.intentNotes;
    }
    setLabelIntentDraft(nextIntentDraft);
    setLabelReasonDraft(nextReasonDraft);
    setLabelNotesDraft(nextNotesDraft);

    if (loaded.length === 0) {
      setMessages([getWelcomeMessage()]);
    } else {
      setMessages(loaded);
    }
  };

  const persistMessage = async (caseId: string, message: Message) => {
    await fetch(`/api/cases/${encodeURIComponent(caseId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: message.id,
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
        createdAt: message.createdAt || getMessageCreatedAt(),
        records: message.records,
        graph: message.graph,
        cypher: message.cypher,
        candidateQueries: message.candidateQueries,
        queryEvaluation: message.queryEvaluation,
        modelResponses: message.modelResponses,
        error: Boolean(message.error),
        predictedIntent: message.predictedIntent,
        intentConfidence: message.intentConfidence,
        strategyUsed: message.strategyUsed,
      }),
    });
  };

  const loadConfusionMatrix = async (caseId: string) => {
    setMatrixLoading(true);
    try {
      const res = await fetch(
        `/api/metrics/confusion-matrix?caseId=${encodeURIComponent(caseId)}`,
        { cache: 'no-store' },
      );
      const data = (await res.json()) as ConfusionMatrixPayload;
      if (!res.ok || !data.success) {
        throw new Error('Failed to load confusion matrix.');
      }
      setMatrixData(data);
    } catch {
      setMatrixData(null);
    } finally {
      setMatrixLoading(false);
    }
  };

  const saveIntentLabel = async (msg: Message) => {
    if (!msg.id || !activeCaseId) return;
    const trueIntent =
      labelIntentDraft[msg.id] || msg.trueIntent || msg.predictedIntent;
    if (!trueIntent) return;

    setLabelSaving((prev) => ({ ...prev, [msg.id]: true }));
    try {
      const reasonTag = labelReasonDraft[msg.id] || msg.intentReasonTag || '';
      const notes = labelNotesDraft[msg.id] || msg.intentNotes || '';
      const res = await fetch('/api/metrics/intent-label', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: msg.id,
          trueIntent,
          reasonTag: reasonTag || undefined,
          notes: notes || undefined,
          predictedIntent: msg.predictedIntent || 'other',
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || 'Failed to save label.');
      }
      await loadCaseMessages(activeCaseId);
      await loadConfusionMatrix(activeCaseId);
      setEditReviewedLabel((prev) => ({ ...prev, [msg.id]: false }));
      window.dispatchEvent(new Event('case-history-updated'));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to save label.';
      const errorMsg: Message = {
        id: createMessageId('label-error'),
        role: 'system',
        content: `Label save failed: ${message}`,
        timestamp: getTimestamp(),
        createdAt: getMessageCreatedAt(),
        error: true,
      };
      setMessages((prev) => [...prev, errorMsg]);
      if (activeCaseId) {
        void persistMessage(activeCaseId, errorMsg).then(() =>
          window.dispatchEvent(new Event('case-history-updated')),
        );
      }
    } finally {
      setLabelSaving((prev) => ({ ...prev, [msg.id]: false }));
    }
  };

  const loadLatestSystemMessageFromDb = async (
    caseId: string,
  ): Promise<Message | null> => {
    const attempts = 4;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const res = await fetch(
        `/api/cases/${encodeURIComponent(caseId)}/messages`,
        { cache: 'no-store' },
      );
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success && Array.isArray(data.messages)) {
        const messagesFromDb = data.messages as Message[];
        for (let i = messagesFromDb.length - 1; i >= 0; i -= 1) {
          const msg = messagesFromDb[i];
          if (msg.role !== 'system') continue;
          if (
            (msg.graph &&
              Array.isArray(msg.graph.nodes) &&
              msg.graph.nodes.length > 0) ||
            (msg.records && msg.records.length > 0) ||
            (typeof msg.cypher === 'string' && msg.cypher.trim().length > 0)
          ) {
            return msg;
          }
        }
      }
      if (attempt < attempts - 1) {
        await wait(180);
      }
    }

    return null;
  };

  useEffect(() => {
    let ignore = false;
    const boot = async () => {
      setIsCaseLoading(true);
      try {
        let selectedCaseId = caseParam;
        if (!selectedCaseId) {
          const latestCase = await getLatestCase();
          if (latestCase?.caseId) {
            selectedCaseId = latestCase.caseId;
            router.replace(
              `/analyze?case=${encodeURIComponent(latestCase.caseId)}`,
            );
          } else {
            const created = await createCaseIfMissing();
            selectedCaseId = created.caseId;
            router.replace(
              `/analyze?case=${encodeURIComponent(created.caseId)}`,
            );
          }
        }
        if (!selectedCaseId || ignore) return;
        setActiveCaseId(selectedCaseId);
        await loadCaseMessages(selectedCaseId);
        await loadConfusionMatrix(selectedCaseId);
      } catch {
        if (!ignore) {
          setMessages([getWelcomeMessage()]);
        }
      } finally {
        if (!ignore) {
          setIsCaseLoading(false);
        }
      }
    };
    void boot();

    return () => {
      ignore = true;
    };
  }, [caseParam, router]);

  // Auto-scroll to bottom on new messages or operation updates
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, operationState]);

  const suggestions = useMemo(() => getSuggestions(messages), [messages]);

  const downloadRecordsAsFile = async (
    records: Record<string, unknown>[],
    format: ExportFormat,
    baseName: string,
    options?: {
      mode?: ExportMode;
      query?: string;
      explanation?: string;
      cypher?: string;
    },
  ) => {
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        format,
        records,
        filename: baseName,
        mode: options?.mode || 'records',
        query: options?.query || '',
        explanation: options?.explanation || '',
        cypher: options?.cypher || '',
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || 'Export generation failed.');
    }

    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename=\"?([^"]+)\"?/i);
    const fileName = match?.[1] || `${baseName}.${format}`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';

    // Guard cleanup to avoid DOM removeChild race issues in strict/concurrent renders.
    document.body.appendChild(link);
    link.click();

    setTimeout(() => {
      if (document.body.contains(link)) {
        document.body.removeChild(link);
      }
      URL.revokeObjectURL(url);
    }, 0);
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isProcessing || !activeCaseId) return;

    const userQuery = input.trim();
    const requestedExportFormat = detectRequestedExportFormat(userQuery);
    const requestedExportMode = detectExportMode(userQuery);
    const includeGraph = detectFlowchartRequest(userQuery);
    const newUserMsg: Message = {
      id: createMessageId('user'),
      role: 'user',
      content: userQuery,
      timestamp: getTimestamp(),
      createdAt: getMessageCreatedAt(),
    };

    const historyForContext = messages
      .filter((m) => m.role === 'user' || m.role === 'system')
      .slice(-60)
      .map((m) => ({ role: m.role, content: m.content }));

    setMessages((prev) => [...prev, newUserMsg]);
    setInput('');
    setIsProcessing(true);
    void persistMessage(activeCaseId, newUserMsg).then(() =>
      window.dispatchEvent(new Event('case-history-updated')),
    );

    let agentRetriesExhausted = false;

    try {
      const startsWithCypherClause =
        /^\s*(match|optional\s+match|merge|with|return|unwind)\b/i.test(
          userQuery,
        );
      const startsWithCypherProcedure =
        /^\s*call\s+[A-Za-z_][A-Za-z0-9_.]*\s*\(/i.test(userQuery);
      const isLikelyCypher =
        startsWithCypherClause || startsWithCypherProcedure;
      const isFlowchartOnlyRequest =
        detectFlowchartOnlyRequest(userQuery) && !isLikelyCypher;

      if (isFlowchartOnlyRequest) {
        const sourceMessage = await loadLatestSystemMessageFromDb(activeCaseId);

        if (sourceMessage) {
          let derivedGraph: GraphPayload | null =
            sourceMessage.graph && sourceMessage.graph.nodes.length > 0
              ? sourceMessage.graph
              : null;

          if (
            !derivedGraph &&
            sourceMessage.records &&
            sourceMessage.records.length > 0
          ) {
            derivedGraph = extractGraphFromRecords(
              sourceMessage.records as Record<string, unknown>[],
            );
            if (!derivedGraph.nodes.length) {
              derivedGraph = inferGraphFromCallActivityRows(
                sourceMessage.records as Record<string, unknown>[],
                sourceMessage.cypher,
              );
            }
          }

          if (
            !derivedGraph &&
            typeof sourceMessage.cypher === 'string' &&
            sourceMessage.cypher.trim()
          ) {
            const graphRes = await fetch('/api/neo4j/query', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                query: sourceMessage.cypher,
                includeGraph: true,
              }),
            });
            const graphData = await graphRes.json().catch(() => null);
            if (
              graphRes.ok &&
              graphData?.success &&
              graphData?.graph?.nodes?.length
            ) {
              derivedGraph = graphData.graph as GraphPayload;
            }
          }

          if (derivedGraph && derivedGraph.nodes.length > 0) {
            const chartMsg: Message = {
              id: createMessageId('system'),
              role: 'system',
              content: `Relationship flowchart generated from the previous output.\n\n${buildFlowchartMarkdown(derivedGraph)}`,
              timestamp: getTimestamp(),
              createdAt: getMessageCreatedAt(),
              graph: derivedGraph,
              predictedIntent: 'flowchart_request',
              intentConfidence: 'high',
              strategyUsed: 'flowchart_from_history',
            };
            setMessages((prev) => [...prev, chartMsg]);
            void persistMessage(activeCaseId, chartMsg).then(() =>
              window.dispatchEvent(new Event('case-history-updated')),
            );
            return;
          }
        }

        const noDataMsg: Message = {
          id: createMessageId('system'),
          role: 'system',
          content:
            'No prior graph-ready records were found in this case history to build a flowchart.',
          timestamp: getTimestamp(),
          createdAt: getMessageCreatedAt(),
          error: true,
          predictedIntent: 'flowchart_request',
          intentConfidence: 'high',
          strategyUsed: 'flowchart_from_history',
        };
        setMessages((prev) => [...prev, noDataMsg]);
        void persistMessage(activeCaseId, noDataMsg).then(() =>
          window.dispatchEvent(new Event('case-history-updated')),
        );
        return;
      }

      if (isLikelyCypher) {
        setOperationState(createInitialOperation('cypher'));

        const res = await fetch('/api/neo4j/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: userQuery, includeGraph }),
        });

        setOperationState((prev) => {
          if (!prev) return prev;
          const next = { ...prev };
          next.steps = updateStepStatus(next.steps, 'plan', 'done');
          next.steps = updateStepStatus(next.steps, 'fetch', 'active');
          next.logs = appendLog(
            next.logs,
            'Neo4j query execution in progress.',
          );
          return next;
        });

        const data = await res.json();

        if (res.ok && data.success) {
          const formatted = formatRecords(data.records);
          const timing = data.summary?.resultAvailableAfter;
          const content =
            formatted +
            (timing != null ? `\n\n⏱ Query completed in ${timing}ms` : '');

          setOperationState((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              steps: prev.steps.map((s) => ({ ...s, status: 'done' })),
              logs: appendLog(prev.logs, 'Result formatted and ready.'),
              recordPreview: (data.records as Record<string, unknown>[]).slice(
                0,
                3,
              ),
            };
          });

          const newSystemMsg: Message = {
            id: createMessageId('system'),
            role: 'system',
            content,
            timestamp: getTimestamp(),
            createdAt: getMessageCreatedAt(),
            records: data.records,
            graph: data.graph,
            predictedIntent: 'other',
            intentConfidence: 'low',
            strategyUsed: 'direct_cypher',
            exportRequest:
              requestedExportFormat && data.records?.length
                ? {
                    format: requestedExportFormat,
                    mode: requestedExportMode,
                    baseName: 'cypher_export',
                    label:
                      requestedExportMode === 'detailed'
                        ? `Download ${requestedExportFormat.toUpperCase()} (Detailed)`
                        : `Download ${requestedExportFormat.toUpperCase()}`,
                    query: userQuery,
                    explanation: content,
                  }
                : undefined,
          };
          setMessages((prev) => [...prev, newSystemMsg]);
          void persistMessage(activeCaseId, newSystemMsg).then(() =>
            window.dispatchEvent(new Event('case-history-updated')),
          );
        } else {
          throw new Error(data.error || 'Unknown error from server.');
        }
      } else {
        const AGENT_MAX_ATTEMPTS = 3;
        let lastAgentError: Error | null = null;

        for (let attempt = 0; attempt < AGENT_MAX_ATTEMPTS; attempt++) {
          if (attempt > 0) {
            const retryMsg: Message = {
              id: createMessageId(`retry-${attempt}`),
              role: 'system',
              content: 'Failed to generate, trying again.',
              timestamp: getTimestamp(),
              createdAt: getMessageCreatedAt(),
            };
            setMessages((prev) => [...prev, retryMsg]);
            void persistMessage(activeCaseId, retryMsg).then(() =>
              window.dispatchEvent(new Event('case-history-updated')),
            );
          }

          setOperationState(createInitialOperation('agent'));

          try {
            const res = await fetch('/api/agent/query', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                message: userQuery,
                includeGraph,
                history: historyForContext,
                caseId: activeCaseId,
                stream: true,
              }),
            });

            if (!res.ok || !res.body) {
              const text = await res.text();
              throw new Error(text || `Request failed (${res.status}).`);
            }

            let finalPayload: StreamFinalPayload | null = null;
            let streamError: string | null = null;

            await consumeSSE(res, (event, payload) => {
              if (event === 'progress') {
                const progress = payload as AgentProgressEvent;
                setOperationState((prev) =>
                  prev ? applyProgressEvent(prev, progress) : prev,
                );
                return;
              }

              if (event === 'final') {
                finalPayload = payload as StreamFinalPayload;
                return;
              }

              if (event === 'error') {
                const errPayload = payload as { error?: string };
                streamError = errPayload.error || 'Agent stream failed.';
              }
            });

            if (streamError) {
              throw new Error(streamError);
            }

            if (!finalPayload) {
              throw new Error('Agent stream ended without a final response.');
            }
            const payload = finalPayload as StreamFinalPayload;
            if (!payload.success) {
              throw new Error('Agent response failed.');
            }

            const newSystemMsg: Message = {
              id: createMessageId('system'),
              role: 'system',
              content: payload.finalAnswer,
              timestamp: getTimestamp(),
              createdAt: getMessageCreatedAt(),
              records: payload.records,
              graph: payload.graph,
              cypher: payload.cypher,
              candidateQueries: payload.candidateQueries,
              queryEvaluation: payload.queryEvaluation,
              modelResponses: payload.modelResponses,
              predictedIntent: payload.predictedIntent || 'other',
              intentConfidence: payload.intentConfidence || 'low',
              strategyUsed: payload.strategyUsed || 'llm_generated',
              exportRequest:
                requestedExportFormat && payload.records?.length
                  ? {
                      format: requestedExportFormat,
                      mode: requestedExportMode,
                      baseName: 'investigation_export',
                      label:
                        requestedExportMode === 'detailed'
                          ? `Download ${requestedExportFormat.toUpperCase()} (Detailed)`
                          : `Download ${requestedExportFormat.toUpperCase()}`,
                      query: userQuery,
                      explanation: payload.finalAnswer,
                      cypher: payload.cypher,
                    }
                  : undefined,
            };

            setMessages((prev) => [...prev, newSystemMsg]);
            void persistMessage(activeCaseId, newSystemMsg).then(() =>
              window.dispatchEvent(new Event('case-history-updated')),
            );
            lastAgentError = null;
            break;
          } catch (inner) {
            lastAgentError =
              inner instanceof Error ? inner : new Error(String(inner));
            if (attempt < AGENT_MAX_ATTEMPTS - 1) {
              continue;
            }
            agentRetriesExhausted = true;
            throw lastAgentError;
          }
        }
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const content = agentRetriesExhausted
        ? `Could not complete your request after several attempts.\n\n${detail}\n\nPlease report this issue if it continues.`
        : `Network error: Could not reach the query service. ${detail}`;

      const errorMsg: Message = {
        id: createMessageId('error'),
        role: 'system',
        content,
        timestamp: getTimestamp(),
        createdAt: getMessageCreatedAt(),
        error: true,
      };
      setMessages((prev) => [...prev, errorMsg]);
      void persistMessage(activeCaseId, errorMsg).then(() =>
        window.dispatchEvent(new Event('case-history-updated')),
      );
    } finally {
      setIsProcessing(false);
      setTimeout(() => setOperationState(null), 1200);
    }
  };

  return (
    <div className="flex flex-col h-screen max-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b border-brand-light/30 px-8 py-5 shrink-0 flex justify-between items-center shadow-sm">
        <div className="flex items-center gap-4">
          <div className="p-2 bg-brand-light/20 rounded-lg">
            <Activity className="w-5 h-5 text-brand-dark" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-brand-dark tracking-tight">
              Intelligence Analysis Console
            </h1>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mt-0.5">
              Secure Session Active
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowModelQuality((prev) => !prev)}
            className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors ${
              showModelQuality
                ? 'border-brand-dark bg-brand-dark text-white'
                : 'border-brand-light/35 bg-white text-brand-dark hover:bg-brand-light/10'
            }`}
          >
            <BarChart3 className="w-4 h-4" />
            Model Quality
          </button>
          {activeCaseId && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-white text-brand-dark rounded-md border border-brand-light/35">
              <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
                Case
              </span>
              <span className="text-xs font-semibold">
                {activeCaseId.slice(0, 8)}
              </span>
            </div>
          )}
          <div className="flex items-center gap-2 px-3 py-1.5 bg-brand-light/10 text-brand-dark rounded-md border border-brand-light/30">
            <Database className="w-4 h-4" />
            <span className="text-xs font-semibold">Neo4j Connected</span>
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 bg-emerald-50 text-emerald-700 rounded-md border border-emerald-200">
            <Shield className="w-4 h-4" />
            <span className="text-xs font-semibold">Protected Environment</span>
          </div>
        </div>
      </header>

      {/* Main Chat Area */}
      <div className="flex-1 overflow-y-auto p-8 relative scroll-smooth">
        {/* Centered Emblem Background */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-50">
          <img
            src="/logos/emblem.png"
            alt="Emblem"
            className="max-w-xs w-1/3 object-contain opacity-20 grayscale"
          />
        </div>

        {/* Foreground Chat Content */}
        <div className="relative flex flex-col gap-6">
          {showModelQuality && (
            <section className="rounded-xl border border-brand-light/30 bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-bold text-brand-dark">
                    Model Quality Metrics
                  </h2>
                  <p className="text-[11px] text-slate-500">
                    Reviewer-labeled intent confusion metrics for this case.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (activeCaseId) {
                      void loadConfusionMatrix(activeCaseId);
                    }
                  }}
                  disabled={matrixLoading || !activeCaseId}
                  className="inline-flex items-center gap-2 rounded-md border border-brand-light/35 bg-white px-3 py-1.5 text-xs font-semibold text-brand-dark hover:bg-brand-light/10 disabled:opacity-50"
                >
                  {matrixLoading ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <BarChart3 className="w-3.5 h-3.5" />
                  )}
                  Refresh
                </button>
              </div>

              {!matrixData ? (
                <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                  No matrix data yet.
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
                    <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
                      <div className="text-slate-500">Labeled</div>
                      <div className="text-sm font-semibold text-brand-dark">
                        {matrixData.totalLabeled}
                      </div>
                    </div>
                    <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
                      <div className="text-slate-500">Unlabeled</div>
                      <div className="text-sm font-semibold text-brand-dark">
                        {matrixData.unresolvedLabelCount}
                      </div>
                    </div>
                    <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
                      <div className="text-slate-500">Macro F1</div>
                      <div className="text-sm font-semibold text-brand-dark">
                        {matrixData.macro.f1}
                      </div>
                    </div>
                    <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
                      <div className="text-slate-500">Micro F1</div>
                      <div className="text-sm font-semibold text-brand-dark">
                        {matrixData.micro.f1}
                      </div>
                    </div>
                    <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
                      <div className="text-slate-500">Macro Recall</div>
                      <div className="text-sm font-semibold text-brand-dark">
                        {matrixData.macro.recall}
                      </div>
                    </div>
                  </div>

                  <details className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
                    <summary className="cursor-pointer font-semibold text-slate-700">
                      Per-intent Precision / Recall / F1
                    </summary>
                    <div className="mt-2 max-h-64 overflow-auto rounded border border-slate-200 bg-white">
                      <table className="min-w-full border-collapse text-[11px]">
                        <thead className="bg-slate-100">
                          <tr>
                            <th className="border-b border-slate-200 px-2 py-1 text-left">
                              Intent
                            </th>
                            <th className="border-b border-slate-200 px-2 py-1 text-left">
                              Support
                            </th>
                            <th className="border-b border-slate-200 px-2 py-1 text-left">
                              Precision
                            </th>
                            <th className="border-b border-slate-200 px-2 py-1 text-left">
                              Recall
                            </th>
                            <th className="border-b border-slate-200 px-2 py-1 text-left">
                              F1
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {matrixData.stats
                            .filter(
                              (s) => s.support > 0 || s.predictedCount > 0,
                            )
                            .map((s) => (
                              <tr
                                key={`stat-${s.intent}`}
                                className="odd:bg-white even:bg-slate-50"
                              >
                                <td className="border-b border-slate-100 px-2 py-1">
                                  {s.intent}
                                </td>
                                <td className="border-b border-slate-100 px-2 py-1">
                                  {s.support}
                                </td>
                                <td className="border-b border-slate-100 px-2 py-1">
                                  {s.precision}
                                </td>
                                <td className="border-b border-slate-100 px-2 py-1">
                                  {s.recall}
                                </td>
                                <td className="border-b border-slate-100 px-2 py-1">
                                  {s.f1}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </details>

                  <details className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
                    <summary className="cursor-pointer font-semibold text-slate-700">
                      Top Intent Confusions
                    </summary>
                    <div className="mt-2 space-y-1">
                      {matrixData.topConfusions.length === 0 ? (
                        <p className="text-[11px] text-slate-500">
                          No cross-intent confusion records yet.
                        </p>
                      ) : (
                        matrixData.topConfusions.map((c, idx) => (
                          <div
                            key={`${c.trueIntent}-${c.predictedIntent}-${idx}`}
                            className="rounded border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700"
                          >
                            true:{' '}
                            <span className="font-semibold">
                              {c.trueIntent}
                            </span>{' '}
                            {'->'} predicted:{' '}
                            <span className="font-semibold">
                              {c.predictedIntent}
                            </span>{' '}
                            ({c.count})
                          </div>
                        ))
                      )}
                    </div>
                  </details>
                </div>
              )}
            </section>
          )}

          {isCaseLoading && (
            <div className="flex w-full justify-start">
              <div className="max-w-[85%] rounded-xl border border-brand-light/30 bg-white px-4 py-3 text-sm text-slate-600 shadow-sm flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-brand-dark" />
                Loading case history...
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex w-full ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`flex items-start gap-4 max-w-[85%] ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}
              >
                {/* Avatar */}
                <div
                  className={`shrink-0 w-10 h-10 rounded-lg flex items-center justify-center border shadow-sm ${
                    msg.role === 'user'
                      ? 'bg-white border-brand-light/30 text-brand-dark'
                      : msg.error
                        ? 'bg-red-600 border-red-600 text-white'
                        : 'bg-brand-dark border-brand-dark text-white'
                  }`}
                >
                  {msg.role === 'user' ? (
                    <User className="w-5 h-5" />
                  ) : msg.error ? (
                    <AlertTriangle className="w-5 h-5" />
                  ) : (
                    <TerminalSquare className="w-5 h-5" />
                  )}
                </div>

                {/* Message Content */}
                <div
                  className={`p-5 rounded-xl border shadow-sm ${
                    msg.role === 'user'
                      ? 'bg-white border-brand-light/30 rounded-tr-sm bg-opacity-90'
                      : msg.error
                        ? 'bg-red-50 border-red-200 rounded-tl-sm bg-opacity-90'
                        : 'bg-white border-brand-light/20 rounded-tl-sm bg-opacity-90'
                  }`}
                >
                  <div className="flex items-center mb-2 gap-3 justify-between">
                    <span
                      className={`text-xs font-bold uppercase tracking-wider ${
                        msg.role === 'user'
                          ? 'text-slate-500'
                          : msg.error
                            ? 'text-red-600'
                            : 'text-brand-dark'
                      }`}
                    >
                      {msg.role === 'user'
                        ? 'Investigator Query'
                        : msg.error
                          ? 'System Error'
                          : 'System Analysis'}
                    </span>
                    <span className="text-xs text-slate-400 font-mono tracking-tighter">
                      {msg.timestamp}
                    </span>
                  </div>
                  {msg.role === 'user' ? (
                    <div className="text-[15px] leading-relaxed whitespace-pre-wrap text-slate-700 font-sans">
                      {msg.content}
                    </div>
                  ) : (
                    <MarkdownMessage
                      className={`chat-markdown text-[15px] leading-relaxed ${
                        msg.error ? 'text-red-700' : 'text-brand-dark/90'
                      }`}
                      content={msg.content}
                    />
                  )}
                  {msg.role === 'system' &&
                    !msg.error &&
                    msg.predictedIntent &&
                    (msg.trueIntent && !editReviewedLabel[msg.id] ? (
                      <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-[11px] text-emerald-800">
                            Reviewed intent:{' '}
                            <span className="font-semibold">
                              {msg.trueIntent}
                            </span>
                            {msg.intentReasonTag ? (
                              <> ({msg.intentReasonTag})</>
                            ) : null}
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              setEditReviewedLabel((prev) => ({
                                ...prev,
                                [msg.id]: true,
                              }))
                            }
                            className="rounded border border-emerald-300 bg-white px-2 py-1 text-[11px] font-semibold text-emerald-800 hover:bg-emerald-100"
                          >
                            Re-label
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-3 rounded-md border border-brand-light/35 bg-brand-light/10 p-3">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="text-[11px] font-semibold uppercase tracking-wide text-brand-dark/80">
                            Intent Review
                          </span>
                          <span className="text-[11px] text-slate-600">
                            predicted:{' '}
                            <span className="font-semibold">
                              {msg.predictedIntent}
                            </span>{' '}
                            ({msg.intentConfidence || 'low'})
                          </span>
                        </div>
                        <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                          <select
                            value={
                              labelIntentDraft[msg.id] ||
                              msg.trueIntent ||
                              msg.predictedIntent
                            }
                            onChange={(e) =>
                              setLabelIntentDraft((prev) => ({
                                ...prev,
                                [msg.id]: e.target.value as InvestigationIntent,
                              }))
                            }
                            className="rounded border border-brand-light/50 bg-white px-2 py-1 text-[11px] text-slate-700 outline-none focus:border-brand-dark"
                          >
                            {INVESTIGATION_INTENTS.map((intent) => (
                              <option
                                key={`${msg.id}-${intent}`}
                                value={intent}
                              >
                                {intent}
                              </option>
                            ))}
                          </select>

                          <select
                            value={
                              labelReasonDraft[msg.id] ||
                              msg.intentReasonTag ||
                              ''
                            }
                            onChange={(e) =>
                              setLabelReasonDraft((prev) => ({
                                ...prev,
                                [msg.id]: e.target.value,
                              }))
                            }
                            className="rounded border border-brand-light/50 bg-white px-2 py-1 text-[11px] text-slate-700 outline-none focus:border-brand-dark"
                          >
                            <option value="">reason tag (optional)</option>
                            {INTENT_REASON_TAGS.map((tag) => (
                              <option key={`${msg.id}-${tag}`} value={tag}>
                                {tag}
                              </option>
                            ))}
                          </select>

                          <button
                            type="button"
                            onClick={() => void saveIntentLabel(msg)}
                            disabled={Boolean(labelSaving[msg.id])}
                            className="inline-flex items-center justify-center gap-1 rounded border border-brand-light/40 bg-white px-2 py-1 text-[11px] font-semibold text-brand-dark hover:bg-brand-light/15 disabled:opacity-50"
                          >
                            {labelSaving[msg.id] ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <Save className="w-3 h-3" />
                            )}
                            Save Label
                          </button>
                        </div>
                        <input
                          value={
                            labelNotesDraft[msg.id] || msg.intentNotes || ''
                          }
                          onChange={(e) =>
                            setLabelNotesDraft((prev) => ({
                              ...prev,
                              [msg.id]: e.target.value,
                            }))
                          }
                          placeholder="Optional reviewer note"
                          className="mt-2 w-full rounded border border-brand-light/50 bg-white px-2 py-1 text-[11px] text-slate-700 outline-none focus:border-brand-dark"
                        />
                      </div>
                    ))}
                  {msg.exportRequest &&
                    msg.records &&
                    msg.records.length > 0 && (
                      <div className="mt-3">
                        <button
                          type="button"
                          onClick={() =>
                            void downloadRecordsAsFile(
                              msg.records as Record<string, unknown>[],
                              msg.exportRequest?.format as ExportFormat,
                              msg.exportRequest?.baseName ||
                                'investigation_export',
                              {
                                mode: msg.exportRequest?.mode || 'records',
                                query: msg.exportRequest?.query || '',
                                explanation:
                                  msg.exportRequest?.explanation || '',
                                cypher:
                                  msg.exportRequest?.cypher || msg.cypher || '',
                              },
                            )
                          }
                          className="inline-flex items-center gap-2 rounded-md border border-brand-light/40 bg-white px-3 py-1.5 text-xs font-semibold text-brand-dark hover:bg-brand-light/10 transition-colors"
                        >
                          <Download className="w-3.5 h-3.5" />
                          {msg.exportRequest.label}
                        </button>
                      </div>
                    )}

                  {msg.role === 'system' &&
                    (msg.cypher ||
                      msg.records ||
                      msg.graph ||
                      msg.modelResponses ||
                      msg.queryEvaluation ||
                      msg.candidateQueries?.length) && (
                      <div className="mt-4 space-y-2">
                        {msg.graph &&
                          Array.isArray(msg.graph.nodes) &&
                          msg.graph.nodes.length > 0 && (
                            <details
                              open
                              className="group rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs"
                            >
                              <summary className="flex cursor-pointer items-center justify-between text-slate-600 font-semibold">
                                <span>
                                  Relationship Flowchart (
                                  {msg.graph.meta?.nodeCount ??
                                    msg.graph.nodes.length}{' '}
                                  nodes,{' '}
                                  {msg.graph.meta?.edgeCount ??
                                    (Array.isArray(msg.graph.edges)
                                      ? msg.graph.edges.length
                                      : 0)}{' '}
                                  edges)
                                </span>
                                <span className="text-[10px] uppercase tracking-wide text-slate-400">
                                  VIEW
                                </span>
                              </summary>
                              <div className="mt-2">
                                {msg.graph.meta?.truncated && (
                                  <div className="mb-2 inline-flex items-center rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] font-semibold text-amber-700 uppercase tracking-wide">
                                    Partial Graph Shown
                                  </div>
                                )}
                                <MarkdownMessage
                                  className="chat-markdown text-[13px] leading-relaxed text-brand-dark/90"
                                  content={buildFlowchartMarkdown(msg.graph)}
                                />
                              </div>
                            </details>
                          )}

                        {msg.queryEvaluation && (
                          <details className="group rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
                            <summary className="flex cursor-pointer items-center justify-between text-slate-600 font-semibold">
                              <span>Query Strategy Evaluation</span>
                              <span className="text-[10px] uppercase tracking-wide text-slate-400">
                                VIEW
                              </span>
                            </summary>
                            <div className="mt-2 whitespace-pre-wrap text-[11px] text-slate-700">
                              {msg.queryEvaluation}
                            </div>
                          </details>
                        )}

                        {msg.candidateQueries &&
                          msg.candidateQueries.length > 0 && (
                            <details className="group rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
                              <summary className="flex cursor-pointer items-center justify-between text-slate-600 font-semibold">
                                <span>
                                  Candidate Cypher Strategies (
                                  {msg.candidateQueries.length})
                                </span>
                                <span className="text-[10px] uppercase tracking-wide text-slate-400">
                                  VIEW
                                </span>
                              </summary>
                              <div className="mt-2 space-y-2">
                                {msg.candidateQueries.map((candidate, idx) => (
                                  <pre
                                    key={`${msg.id}-candidate-${idx}`}
                                    className="whitespace-pre-wrap rounded bg-slate-900/90 p-2 font-mono text-[11px] text-slate-100"
                                  >
                                    {candidate}
                                  </pre>
                                ))}
                              </div>
                            </details>
                          )}

                        {msg.cypher && (
                          <details className="group rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
                            <summary className="flex cursor-pointer items-center justify-between text-slate-600 font-semibold">
                              <span>Generated Cypher</span>
                              <span className="text-[10px] uppercase tracking-wide text-slate-400">
                                VIEW
                              </span>
                            </summary>
                            <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] text-slate-700">
                              {msg.cypher}
                            </pre>
                          </details>
                        )}

                        {msg.records && msg.records.length > 0 && (
                          <details className="group rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
                            <summary className="flex cursor-pointer items-center justify-between text-slate-600 font-semibold">
                              <span>Raw DB Records ({msg.records.length})</span>
                              <span className="text-[10px] uppercase tracking-wide text-slate-400">
                                TABLE / JSON
                              </span>
                            </summary>
                            <div className="mt-2 space-y-3">
                              {(() => {
                                const first = msg.records?.[0] ?? {};
                                const keys = Object.keys(first);
                                const allScalars =
                                  keys.length > 0 &&
                                  msg.records?.every((r) =>
                                    keys.every((k) => {
                                      const v = r[k];
                                      return (
                                        v === null ||
                                        typeof v === 'string' ||
                                        typeof v === 'number' ||
                                        typeof v === 'boolean'
                                      );
                                    }),
                                  );

                                if (!allScalars || keys.length === 0) {
                                  return null;
                                }

                                return (
                                  <div className="max-h-64 overflow-auto rounded border border-slate-200 bg-white">
                                    <table className="min-w-full border-collapse text-[11px]">
                                      <thead className="bg-slate-100">
                                        <tr>
                                          {keys.map((k) => (
                                            <th
                                              key={k}
                                              className="border-b border-slate-200 px-2 py-1 text-left font-semibold text-slate-700"
                                            >
                                              {k}
                                            </th>
                                          ))}
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {msg.records?.map((row, idx) => (
                                          <tr
                                            key={idx}
                                            className={
                                              idx % 2 === 0
                                                ? 'bg-white'
                                                : 'bg-slate-50'
                                            }
                                          >
                                            {keys.map((k) => (
                                              <td
                                                key={k}
                                                className="border-b border-slate-100 px-2 py-1 text-slate-700"
                                              >
                                                {String(row[k] ?? '')}
                                              </td>
                                            ))}
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                );
                              })()}

                              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-slate-900/90 p-2 font-mono text-[11px] text-slate-100">
                                {JSON.stringify(msg.records, null, 2)}
                              </pre>
                            </div>
                          </details>
                        )}

                        {msg.modelResponses &&
                          msg.modelResponses.length > 0 && (
                            <details className="group rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
                              <summary className="flex cursor-pointer items-center justify-between text-slate-600 font-semibold">
                                <span>
                                  Model Opinions ({msg.modelResponses.length})
                                </span>
                                <span className="text-[10px] uppercase tracking-wide text-slate-400">
                                  VIEW
                                </span>
                              </summary>
                              <div className="mt-2 space-y-2">
                                {msg.modelResponses.map((opinion, idx) => (
                                  <details
                                    key={`${opinion.provider}-${idx}`}
                                    className="rounded border border-slate-200 bg-white px-3 py-2"
                                  >
                                    <summary className="flex cursor-pointer items-center justify-between text-[11px] font-semibold text-slate-700">
                                      <span>
                                        {opinion.provider} - {opinion.model}
                                      </span>
                                      <span className="text-[9px] uppercase tracking-wide text-slate-400">
                                        EXPAND
                                      </span>
                                    </summary>
                                    <div className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-slate-800">
                                      {opinion.content}
                                    </div>
                                  </details>
                                ))}
                              </div>
                            </details>
                          )}
                      </div>
                    )}
                </div>
              </div>
            </div>
          ))}

          {isProcessing && operationState && (
            <div className="flex w-full justify-start">
              <div className="flex items-start gap-4 flex-row max-w-[85%] w-full">
                <div className="shrink-0 w-10 h-10 rounded-lg flex items-center justify-center border shadow-sm bg-brand-dark border-brand-dark text-white">
                  <Sparkles className="w-5 h-5 animate-pulse" />
                </div>
                <div className="p-5 rounded-xl border shadow-sm bg-white border-brand-light/20 rounded-tl-sm w-full">
                  <div className="flex items-center gap-2 text-brand-dark font-semibold text-sm mb-3">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {operationState.title}
                  </div>

                  <ol className="space-y-2">
                    {operationState.steps.map((step) => (
                      <li
                        key={step.key}
                        className="flex items-center gap-2 text-xs text-slate-700 transition-all duration-300"
                      >
                        {step.status === 'done' ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                        ) : step.status === 'active' ? (
                          <Loader2 className="w-4 h-4 text-brand-dark animate-spin" />
                        ) : (
                          <div className="w-4 h-4 rounded-full border border-slate-300" />
                        )}
                        <span
                          className={
                            step.status === 'active'
                              ? 'text-brand-dark font-medium'
                              : 'text-slate-600'
                          }
                        >
                          {step.label}
                        </span>
                      </li>
                    ))}
                  </ol>

                  {operationState.recordPreview &&
                    operationState.recordPreview.length > 0 && (
                      <div className="mt-3 rounded border border-slate-200 overflow-auto max-h-32">
                        <table className="min-w-full text-[11px] border-collapse">
                          <thead className="bg-slate-100">
                            <tr>
                              {Object.keys(operationState.recordPreview[0]).map(
                                (k) => (
                                  <th
                                    key={k}
                                    className="px-2 py-1 text-left border-b border-slate-200"
                                  >
                                    {k}
                                  </th>
                                ),
                              )}
                            </tr>
                          </thead>
                          <tbody>
                            {operationState.recordPreview.map((row, idx) => (
                              <tr
                                key={idx}
                                className={idx % 2 ? 'bg-slate-50' : 'bg-white'}
                              >
                                {Object.keys(
                                  operationState.recordPreview?.[0] ?? {},
                                ).map((k) => (
                                  <td
                                    key={k}
                                    className="px-2 py-1 border-b border-slate-100 text-slate-700"
                                  >
                                    {String(row[k] ?? '')}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                  <div className="mt-3 space-y-1">
                    {operationState.logs.map((log, idx) => (
                      <div
                        key={`${log}-${idx}`}
                        className="text-[11px] text-slate-500 animate-fade-in-up"
                        style={{ animationDelay: `${idx * 50}ms` }}
                      >
                        • {log}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>
      </div>

      {/* Input Area */}
      <div className="p-6 bg-white border-t border-brand-light/30 shrink-0 relative z-20">
        {showSuggestions && !isProcessing && suggestions.length > 0 && (
          <div className="absolute bottom-full left-0 w-full mb-4 flex justify-start pointer-events-none z-10 px-4 max-w-5xl mx-auto right-0">
            <div className="flex flex-col gap-2 items-start max-w-3xl pointer-events-auto">
              {suggestions.map((suggestion, idx) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => setInput(suggestion)}
                  className="bg-white/95 backdrop-blur-xl border border-brand-light/40 shadow-sm text-slate-800 px-5 py-2.5 rounded-2xl text-[13px] font-medium hover:bg-slate-50 transition-all duration-300 transform opacity-0 animate-fade-in-up text-left max-w-full truncate hover:shadow-md hover:-translate-y-0.5"
                  style={{
                    animationDelay: `${idx * 70}ms`,
                    animationFillMode: 'forwards',
                  }}
                >
                  <span className="bg-linear-to-r from-brand-dark to-brand-light bg-clip-text text-transparent mr-2 font-bold shrink-0">
                    ✦
                  </span>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        <form
          onSubmit={handleSend}
          className="max-w-5xl mx-auto flex items-end gap-4 relative z-20"
        >
          <div className="flex-1 border-2 border-brand-light/50 rounded-xl overflow-hidden focus-within:border-brand-dark focus-within:ring-4 focus-within:ring-brand-light/20 transition-all bg-slate-50 relative">
            <div className="absolute top-4 left-4 text-slate-400">
              <Search className="w-5 h-5" />
            </div>
            <textarea
              className="w-full bg-transparent border-none focus:ring-0 resize-none py-4 px-12 text-[15px] text-slate-800 placeholder-slate-400 outline-none font-mono"
              placeholder="Ask anything: show table, generate flowchart, trace entities, find anomalies..."
              rows={2}
              value={input}
              disabled={isCaseLoading || !activeCaseId || isProcessing}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend(e);
                }
              }}
            />
          </div>
          <button
            type="submit"
            disabled={
              !input.trim() || isProcessing || isCaseLoading || !activeCaseId
            }
            className="shrink-0 h-[68px] px-8 bg-brand-dark text-white font-medium rounded-xl hover:bg-brand-dark/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-md flex items-center gap-3"
          >
            <span>Execute</span>
            <ArrowRight className="w-5 h-5" />
          </button>
        </form>
        <div className="flex justify-between items-center max-w-5xl mx-auto mt-3">
          <p className="text-xs text-slate-400 font-medium flex items-center gap-1.5">
            <FileText className="w-3.5 h-3.5" />
            All queries are logged in the central investigation registry.
          </p>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-slate-400 font-semibold uppercase tracking-wider">
              AI Suggestions
            </span>
            <button
              type="button"
              onClick={() => setShowSuggestions(!showSuggestions)}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-300 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark focus-visible:ring-offset-2 focus-visible:ring-offset-white ${
                showSuggestions ? 'bg-brand-dark/90' : 'bg-slate-200'
              }`}
            >
              <span className="sr-only">Toggle AI suggestions</span>
              <span
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-300 ease-in-out ${
                  showSuggestions ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AnalyzePage() {
  return (
    <Suspense fallback={<div className="flex-1 ml-72 min-h-screen bg-slate-50" />}>
      <AnalyzePageContent />
    </Suspense>
  );
}
