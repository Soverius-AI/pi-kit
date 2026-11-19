import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service';

export interface A2aAgentRow {
  id: string;
  url: string;
  name: string;
  tokenStorage: 'none' | 'keychain' | 'database';
  token: string | null;
  createdAt: number;
}

@Injectable()
export class A2aAgentsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  async insert(agent: A2aAgentRow): Promise<void> {
    await this.db
      .prepare('INSERT INTO a2a_agents (id, url, name, token_storage, token, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(agent.id, agent.url, agent.name, agent.tokenStorage, agent.token, agent.createdAt);
  }

  async list(): Promise<A2aAgentRow[]> {
    const rows = (await this.db
      .prepare('SELECT id, url, name, token_storage, token, created_at FROM a2a_agents ORDER BY created_at')
      .all()) as RawRow[];
    return rows.map((row) => this.toRow(row));
  }

  async get(id: string): Promise<A2aAgentRow | undefined> {
    const row = (await this.db
      .prepare('SELECT id, url, name, token_storage, token, created_at FROM a2a_agents WHERE id = ?')
      .get(id)) as RawRow | undefined;
    return row ? this.toRow(row) : undefined;
  }

  async rename(id: string, name: string): Promise<void> {
    await this.db.prepare('UPDATE a2a_agents SET name = ? WHERE id = ?').run(name, id);
  }

  async delete(id: string): Promise<void> {
    await this.db.prepare('DELETE FROM a2a_agents WHERE id = ?').run(id);
  }

  private toRow(row: RawRow): A2aAgentRow {
    return {
      id: row.id,
      url: row.url,
      name: row.name,
      tokenStorage: row.token_storage,
      token: row.token,
      createdAt: Number(row.created_at),
    };
  }
}

interface RawRow {
  id: string;
  url: string;
  name: string;
  token_storage: A2aAgentRow['tokenStorage'];
  token: string | null;
  created_at: number;
}
