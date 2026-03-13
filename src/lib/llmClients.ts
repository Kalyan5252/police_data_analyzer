import OpenAI from 'openai';
import Groq from 'groq-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';

export type LLMProvider = 'openai' | 'google' | 'groq';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  provider: LLMProvider;
  model: string;
  content: string;
}

const openaiApiKey = process.env.OPENAI_API_KEY;
const googleApiKey = process.env.GOOGLE_GENAI_API_KEY ?? process.env.GOOGLE_API_KEY;
const groqApiKey = process.env.GROQ_API_KEY;

const openaiClient = openaiApiKey
  ? new OpenAI({ apiKey: openaiApiKey })
  : null;

const googleClient = googleApiKey
  ? new GoogleGenerativeAI(googleApiKey)
  : null;

const groqClient = groqApiKey ? new Groq({ apiKey: groqApiKey }) : null;

export async function callLLM(
  provider: LLMProvider,
  model: string,
  messages: LLMMessage[],
): Promise<LLMResponse> {
  switch (provider) {
    case 'openai': {
      if (!openaiClient) {
        throw new Error('OPENAI_API_KEY is not configured.');
      }
      const completion = await openaiClient.chat.completions.create({
        model,
        messages,
        temperature: 0.2,
      });
      const content = completion.choices[0]?.message?.content ?? '';
      return { provider, model, content };
    }
    case 'google': {
      if (!googleClient) {
        throw new Error('GOOGLE_GENAI_API_KEY / GOOGLE_API_KEY is not configured.');
      }
      const genModel = googleClient.getGenerativeModel({ model });
      const prompt = messages
        .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
        .join('\n\n');
      const result = await genModel.generateContent(prompt);
      const text = result.response.text();
      return { provider, model, content: text };
    }
    case 'groq': {
      if (!groqClient) {
        throw new Error('GROQ_API_KEY is not configured.');
      }
      const completion = await groqClient.chat.completions.create({
        model,
        messages,
        temperature: 0.2,
      });
      const content = completion.choices[0]?.message?.content ?? '';
      return { provider, model, content };
    }
    default:
      throw new Error(`Unsupported provider: ${provider satisfies never}`);
  }
}

