'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
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
} from 'lucide-react';
import MarkdownMessage from '@/components/MarkdownMessage';

type LLMOpinion = {
  provider: string;
  model: string;
  content: string;
};

type Message = {
  id: string;
  role: 'user' | 'system';
  content: string;
  timestamp: string;
  records?: Record<string, unknown>[];
  cypher?: string;
  modelResponses?: LLMOpinion[];
  error?: boolean;
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
  records?: Record<string, unknown>[];
  modelResponses?: LLMOpinion[];
};

const CHAT_HISTORY_KEY = 'analysis-chat-history-v2';
const MAX_SAVED_MESSAGES = 120;

function getTimestamp() {
  return new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function getWelcomeMessage(): Message {
  return {
    id: '1',
    role: 'system',
    content:
      'System Initialized. Neo4j graph database connected securely. Enter a Cypher query or a natural language investigation query.',
    timestamp: getTimestamp(),
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
            { key: 'models', label: 'Calling analysis models', status: 'pending' },
            { key: 'synthesize', label: 'Generating final response', status: 'pending' },
          ]
        : [
            { key: 'plan', label: 'Validating query', status: 'active' },
            { key: 'fetch', label: 'Fetching graph data', status: 'pending' },
            { key: 'models', label: 'Preparing result format', status: 'pending' },
            { key: 'synthesize', label: 'Publishing response', status: 'pending' },
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
  const next = { ...current, steps: [...current.steps], logs: [...current.logs] };

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
    suggestions.push('Create a flowchart of entity relationships from this output.');
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
      suggestions.push('Identify suspicious debit patterns above normal baseline.');
    } else if (/phone|imei|ipdr|location/i.test(q)) {
      suggestions.push('Highlight top 5 numbers by connection frequency.');
    } else {
      suggestions.push('Summarize key facts vs hypotheses from the last response.');
    }
  }

  suggestions.push('What should I investigate next based on this result?');

  return Array.from(new Set(suggestions)).slice(0, 5);
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

export default function AnalyzePage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [operationState, setOperationState] = useState<OperationState | null>(
    null,
  );

  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(CHAT_HISTORY_KEY);
      if (!raw) {
        setMessages([getWelcomeMessage()]);
        return;
      }

      const parsed = JSON.parse(raw) as Message[];
      if (!Array.isArray(parsed) || parsed.length === 0) {
        setMessages([getWelcomeMessage()]);
        return;
      }

      const normalized = parsed
        .filter(
          (m) =>
            m &&
            (m.role === 'user' || m.role === 'system') &&
            typeof m.content === 'string' &&
            typeof m.timestamp === 'string',
        )
        .slice(-MAX_SAVED_MESSAGES);

      setMessages(normalized.length ? normalized : [getWelcomeMessage()]);
    } catch {
      setMessages([getWelcomeMessage()]);
    }
  }, []);

  useEffect(() => {
    if (!messages.length) return;
    localStorage.setItem(
      CHAT_HISTORY_KEY,
      JSON.stringify(messages.slice(-MAX_SAVED_MESSAGES)),
    );
  }, [messages]);

  // Auto-scroll to bottom on new messages or operation updates
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, operationState]);

  const suggestions = useMemo(() => getSuggestions(messages), [messages]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isProcessing) return;

    const userQuery = input.trim();
    const newUserMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: userQuery,
      timestamp: getTimestamp(),
    };

    const historyForContext = messages
      .filter((m) => m.role === 'user' || m.role === 'system')
      .slice(-10)
      .map((m) => ({ role: m.role, content: m.content }));

    setMessages((prev) => [...prev, newUserMsg]);
    setInput('');
    setIsProcessing(true);

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
          next.logs = appendLog(next.logs, 'Neo4j query execution in progress.');
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
              recordPreview: (data.records as Record<string, unknown>[]).slice(0, 3),
            };
          });

          const newSystemMsg: Message = {
            id: (Date.now() + 1).toString(),
            role: 'system',
            content,
            timestamp: getTimestamp(),
            records: data.records,
          };
          setMessages((prev) => [...prev, newSystemMsg]);
        } else {
          throw new Error(data.error || 'Unknown error from server.');
        }
      } else {
        setOperationState(createInitialOperation('agent'));

        const res = await fetch('/api/agent/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: userQuery,
            history: historyForContext,
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
          records: payload.records,
          cypher: payload.cypher,
          modelResponses: payload.modelResponses,
        };

        setMessages((prev) => [...prev, newSystemMsg]);
      }
    } catch (err) {
      const errorMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'system',
        content: `Network error: Could not reach the query service. ${err instanceof Error ? err.message : ''}`,
        timestamp: getTimestamp(),
        error: true,
      };
      setMessages((prev) => [...prev, errorMsg]);
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
                    (msg.cypher || msg.records || msg.modelResponses) && (
                      <div className="mt-4 space-y-2">
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
                                              idx % 2 === 0 ? 'bg-white' : 'bg-slate-50'
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

                        {msg.modelResponses && msg.modelResponses.length > 0 && (
                          <details className="group rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
                            <summary className="flex cursor-pointer items-center justify-between text-slate-600 font-semibold">
                              <span>Model Opinions ({msg.modelResponses.length})</span>
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
                              {Object.keys(operationState.recordPreview[0]).map((k) => (
                                <th key={k} className="px-2 py-1 text-left border-b border-slate-200">
                                  {k}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {operationState.recordPreview.map((row, idx) => (
                              <tr key={idx} className={idx % 2 ? 'bg-slate-50' : 'bg-white'}>
                                {Object.keys(operationState.recordPreview?.[0] ?? {}).map((k) => (
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
      <div className="p-6 bg-white border-t border-brand-light/30 shrink-0">
        <div className="max-w-5xl mx-auto mb-3 flex flex-wrap gap-2">
          {suggestions.map((suggestion, idx) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => setInput(suggestion)}
              className="suggestion-chip"
              style={{ animationDelay: `${idx * 70}ms` }}
            >
              {suggestion}
            </button>
          ))}
        </div>

        <form onSubmit={handleSend} className="max-w-5xl mx-auto flex items-end gap-4">
          <div className="flex-1 border-2 border-brand-light/50 rounded-xl overflow-hidden focus-within:border-brand-dark focus-within:ring-4 focus-within:ring-brand-light/20 transition-all bg-slate-50 relative">
            <div className="absolute top-4 left-4 text-slate-400">
              <Search className="w-5 h-5" />
            </div>
            <textarea
              className="w-full bg-transparent border-none focus:ring-0 resize-none py-4 px-12 text-[15px] text-slate-800 placeholder-slate-400 outline-none font-mono"
              placeholder="Ask anything: show table, generate flowchart, trace entities, find anomalies..."
              rows={2}
              value={input}
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
            disabled={!input.trim() || isProcessing}
            className="shrink-0 h-[68px] px-8 bg-brand-dark text-white font-medium rounded-xl hover:bg-brand-dark/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-md flex items-center gap-3"
          >
            <span>Execute</span>
            <ArrowRight className="w-5 h-5" />
          </button>
        </form>
        <div className="text-center mt-3">
          <p className="text-xs text-slate-400 font-medium flex items-center justify-center gap-1.5">
            <FileText className="w-3.5 h-3.5" />
            All queries are logged in the central investigation registry.
          </p>
        </div>
      </div>
    </div>
  );
}
