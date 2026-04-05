'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
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
} from 'lucide-react';
import MarkdownMessage from '@/components/MarkdownMessage';

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
  cypher?: string;
  candidateQueries?: string[];
  queryEvaluation?: string;
  modelResponses?: LLMOpinion[];
  error?: boolean;
  exportRequest?: ExportRequestInfo;
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
  modelResponses?: LLMOpinion[];
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

  suggestions.push('What should I investigate next based on this result?');

  return Array.from(new Set(suggestions)).slice(0, 3);
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

export default function AnalyzePage() {
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
        cypher: message.cypher,
        modelResponses: message.modelResponses,
        error: Boolean(message.error),
      }),
    });
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
    const newUserMsg: Message = {
      id: Date.now().toString(),
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
      const isLikelyCypher = /^\s*(match|merge|create|with|return)\b/i.test(
        userQuery,
      );

      if (isLikelyCypher) {
        setOperationState(createInitialOperation('cypher'));

        const res = await fetch('/api/neo4j/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: userQuery }),
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
            id: (Date.now() + 1).toString(),
            role: 'system',
            content,
            timestamp: getTimestamp(),
            createdAt: getMessageCreatedAt(),
            records: data.records,
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
              id: `${Date.now()}-retry-${attempt}`,
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
              id: (Date.now() + 1).toString(),
              role: 'system',
              content: payload.finalAnswer,
              timestamp: getTimestamp(),
              createdAt: getMessageCreatedAt(),
              records: payload.records,
              cypher: payload.cypher,
              candidateQueries: payload.candidateQueries,
              queryEvaluation: payload.queryEvaluation,
              modelResponses: payload.modelResponses,
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
        id: (Date.now() + 1).toString(),
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
                      msg.modelResponses ||
                      msg.queryEvaluation ||
                      msg.candidateQueries?.length) && (
                      <div className="mt-4 space-y-2">
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
