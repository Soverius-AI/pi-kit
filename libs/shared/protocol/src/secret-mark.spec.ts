import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConnectRequestSchema } from './connectors';
import { containsSecret, isSecretSchema, redactSecrets, SECRET_PLACEHOLDER } from './secret-mark';
import { LoginAnswerSchema } from './workspace';

const KEY = 'sk-made-up-key-0123456789';

describe('the secret mark', () => {
  it('is read from a field, through optional and nullable wrappers', () => {
    expect(isSecretSchema(z.string().meta({ secret: true }))).toBe(true);
    expect(isSecretSchema(z.string().meta({ secret: true }).optional())).toBe(true);
    expect(isSecretSchema(z.string().meta({ secret: true }).nullable().optional())).toBe(true);
    expect(isSecretSchema(z.string())).toBe(false);
    expect(isSecretSchema(z.string().meta({ id: 'Plain' }))).toBe(false);
  });

  it('is found inside objects, arrays and unions', () => {
    const marked = z.string().meta({ secret: true });
    expect(containsSecret(z.object({ a: z.object({ b: marked }) }))).toBe(true);
    expect(containsSecret(z.array(z.object({ key: marked })))).toBe(true);
    expect(containsSecret(z.union([z.string(), z.object({ key: marked })]))).toBe(true);
    expect(containsSecret(z.object({ a: z.string() }))).toBe(false);
  });

  it('does not loop on a recursive schema', () => {
    type Node = { next?: Node };
    const node: z.ZodType<Node> = z.object({ next: z.lazy(() => node).optional() });
    expect(containsSecret(node)).toBe(false);
  });

  it('replaces the marked field and what the schema does not describe, and keeps the rest', () => {
    const schema = z.object({ provider: z.string(), key: z.string().meta({ secret: true }), nested: z.object({ token: z.string().meta({ secret: true }).optional(), note: z.string() }) });
    const printable = redactSecrets(schema, { provider: 'acme', key: KEY, nested: { token: KEY, note: 'hello' }, stray: KEY });
    expect(printable).toEqual({ provider: 'acme', key: SECRET_PLACEHOLDER, nested: { token: SECRET_PLACEHOLDER, note: 'hello' }, stray: SECRET_PLACEHOLDER });
    expect(JSON.stringify(printable)).not.toContain(KEY);
  });

  it('replaces a whole value when the schema itself is marked', () => {
    expect(redactSecrets(z.string().meta({ secret: true }), KEY)).toBe(SECRET_PLACEHOLDER);
    expect(redactSecrets(z.object({ a: z.string() }).meta({ secret: true }), { a: KEY })).toBe(SECRET_PLACEHOLDER);
  });

  it('prints a schema without a mark as it is', () => {
    const value = { a: 'x', b: [1, 2] };
    expect(redactSecrets(z.object({ a: z.string(), b: z.array(z.number()) }), value)).toBe(value);
  });

  it('marks what the API-key workflow and the connectors send', () => {
    const answer = redactSecrets(LoginAnswerSchema, { promptId: 'p1', value: KEY });
    expect(answer).toEqual({ promptId: 'p1', value: SECRET_PLACEHOLDER });
    const connect = redactSecrets(ConnectRequestSchema, { id: 'linear', scope: 'user', token: KEY, clientId: 'abc', clientSecret: KEY });
    expect(connect).toEqual({ id: 'linear', scope: 'user', token: SECRET_PLACEHOLDER, clientId: 'abc', clientSecret: SECRET_PLACEHOLDER });
  });

  it('changes nothing about validation', () => {
    expect(LoginAnswerSchema.safeParse({ promptId: 'p1', value: KEY }).success).toBe(true);
    expect(LoginAnswerSchema.safeParse({ promptId: 'p1' }).success).toBe(false);
    expect(ConnectRequestSchema.safeParse({ id: 'x', token: KEY }).success).toBe(true);
  });
});
