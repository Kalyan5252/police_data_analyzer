import { getDriver } from '@/lib/neo4j';
import { GRAPH_SCHEMA_DESCRIPTION } from '@/lib/schemaContext';
import { callLLM, LLMMessage, LLMResponse } from '@/lib/llmClients';

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
};

type RunOptions = {
  history?: ConversationTurn[];
  onProgress?: (event: InvestigationProgressEvent) => void | Promise<void>;
};

function buildHistoryContext(history: ConversationTurn[]): string {
  if (!history.length) return '';
  const recent = history.slice(-8);
  const context = recent
    .map((turn, idx) => {
      const clean = turn.content.replace(/\s+/g, ' ').trim().slice(0, 320);
      return `${idx + 1}. ${turn.role.toUpperCase()}: ${clean}`;
    })
    .join('\n');
  return `Recent conversation context:\n${context}\n`;
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
  const user: LLMMessage = {
    role: 'user',
    content: `${historyContext}User natural language question:\n${userQuery}\n\nGenerate an appropriate Cypher query over the described schema.`,
  };

  // Use OpenAI mini model as primary query generator
  const response = await callLLM('openai', 'gpt-4o-mini', [system, user]);
  // Ensure we only return the Cypher (strip markdown fences if present)
  const raw = response.content.trim();
  if (raw.startsWith('```')) {
    const withoutFence = raw
      .replace(/^```[a-zA-Z]*\n?/, '')
      .replace(/```$/, '');
    return withoutFence.trim();
  }
  return raw;
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
      return obj;
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
    content: `${historyContext}User question:\n${userQuery}\n\nCypher executed:\n${cypher}\n\nRaw records (JSON slice):\n${recordsJson}\n\nModel opinions:\n${opinionsBlock}\n\nNow produce the final answer for the officer, following the rules.`,
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
  const cypher = await generateCypher(userQuery, historyContext);
  await emit({
    stage: 'query_ready',
    message: 'Cypher query prepared.',
    meta: { cypher },
  });

  // 2) Execute Neo4j query
  await emit({
    stage: 'fetching_data',
    message: 'Executing Cypher and fetching records from Neo4j.',
  });
  const records = await runCypher(cypher);
  await emit({
    stage: 'data_fetched',
    message: `Fetched ${records.length} record(s) from the graph.`,
    meta: {
      recordCount: records.length,
      preview: records.slice(0, 3),
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
  };
}
