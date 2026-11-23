/** The EMR's database: a schema of its own, made and seeded, for the tests */
import { readFileSync } from 'node:fs';
import '@sqb/postgres';
import { Insert } from '@sqb/builder';
import { SqbClient } from '@sqb/connect';
import { seedRows } from './seed.js';

/** A client of a database given as postgres://user:password@host:port/database, in a schema */
export function clientOf(url: string, schema?: string): SqbClient {
  const u = new URL(url);
  return new SqbClient({
    dialect: 'postgres',
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username) || 'postgres',
    password: u.password ? decodeURIComponent(u.password) : undefined,
    database: u.pathname.slice(1) || 'postgres',
    schema,
  });
}

/** Makes the schema with the EMR's tables and seed rows */
export async function createSchema(
  client: SqbClient,
  schema: string,
): Promise<void> {
  await client.execute(
    'create extension if not exists unaccent with schema public',
  );
  await client.execute(`create schema ${schema}`);
  const ddl = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
    .replace(/--.*$/gm, '')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
  await client.acquire(async connection => {
    await connection.execute(`set search_path to ${schema}`);
    for (const statement of ddl) await connection.execute(statement);
    const rows = seedRows();
    for (const table of [
      'patients',
      'patient_telecoms',
      'patient_addresses',
      'encounters',
      'encounter_diagnoses',
      'lab_tests',
      'lab_results',
    ] as const)
      for (const row of rows[table])
        await connection.execute(Insert(table, row));
  });
}

export async function dropSchema(
  client: SqbClient,
  schema: string,
): Promise<void> {
  await client.execute(`drop schema if exists ${schema} cascade`);
}
