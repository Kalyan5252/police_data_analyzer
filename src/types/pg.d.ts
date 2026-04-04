declare module 'pg' {
  export interface QueryResultRow {
    [column: string]: unknown;
  }

  export interface QueryResult<R = QueryResultRow> {
    rows: R[];
    rowCount: number | null;
  }

  export interface PoolClient {
    query<R = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
    release(): void;
  }

  export class Pool {
    constructor(config?: Record<string, unknown>);
    query<R = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
    connect(): Promise<PoolClient>;
  }
}
