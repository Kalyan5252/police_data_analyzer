import { Pool, PoolClient, QueryResult } from 'pg';

declare global {
  var __pgPool: Pool | undefined;
  var __pgSchemaInit: Promise<void> | undefined;
}

function getConnectionConfig() {
  const connectionString =
    process.env.POSTGRES_URL || process.env.DATABASE_URL || '';

  if (connectionString) {
    return {
      connectionString,
      max: Number(process.env.POSTGRES_POOL_MAX || 10),
      idleTimeoutMillis: Number(process.env.POSTGRES_IDLE_TIMEOUT_MS || 30000),
      connectionTimeoutMillis: Number(
        process.env.POSTGRES_CONN_TIMEOUT_MS || 10000,
      ),
      ssl:
        process.env.POSTGRES_SSL === 'true'
          ? { rejectUnauthorized: false }
          : undefined,
    };
  }

  if (process.env.POSTGRES_HOST && process.env.POSTGRES_USER && process.env.POSTGRES_DB) {
    return {
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT || 5432),
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD || '',
      database: process.env.POSTGRES_DB,
      max: Number(process.env.POSTGRES_POOL_MAX || 10),
      idleTimeoutMillis: Number(process.env.POSTGRES_IDLE_TIMEOUT_MS || 30000),
      connectionTimeoutMillis: Number(
        process.env.POSTGRES_CONN_TIMEOUT_MS || 10000,
      ),
      ssl:
        process.env.POSTGRES_SSL === 'true'
          ? { rejectUnauthorized: false }
          : undefined,
    };
  }

  throw new Error(
    'Postgres configuration missing. Set POSTGRES_URL (or DATABASE_URL) or POSTGRES_HOST/POSTGRES_USER/POSTGRES_DB.',
  );
}

export function getPgPool(): Pool {
  if (!global.__pgPool) {
    const config = getConnectionConfig();
    global.__pgPool = new Pool(config);
  }
  return global.__pgPool;
}

export async function ensurePgSchema(): Promise<void> {
  if (global.__pgSchemaInit) return global.__pgSchemaInit;

  global.__pgSchemaInit = (async () => {
    const pool = getPgPool();
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS case_histories (
          case_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS chat_messages (
          id BIGSERIAL PRIMARY KEY,
          message_id TEXT UNIQUE NOT NULL,
          case_id TEXT NOT NULL REFERENCES case_histories(case_id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('user', 'system')),
          content TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          created_at_iso TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          payload JSONB NOT NULL DEFAULT '{}'::jsonb
        );
      `);

      await client.query(
        'CREATE INDEX IF NOT EXISTS idx_chat_messages_case_created_at ON chat_messages(case_id, created_at);',
      );
      await client.query(
        'CREATE INDEX IF NOT EXISTS idx_case_histories_updated_at ON case_histories(updated_at DESC);',
      );
    } finally {
      client.release();
    }
  })();

  return global.__pgSchemaInit;
}

export async function pgQuery<T = unknown>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  await ensurePgSchema();
  const pool = getPgPool();
  return pool.query<T>(text, params);
}

export async function withPgClient<T>(
  runner: (client: PoolClient) => Promise<T>,
): Promise<T> {
  await ensurePgSchema();
  const pool = getPgPool();
  const client = await pool.connect();
  try {
    return await runner(client);
  } finally {
    client.release();
  }
}
