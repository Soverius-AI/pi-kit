import 'reflect-metadata';
import { Body, Controller, Get, Global, type INestApplication, Logger, Module, Post, Query } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import SwaggerParser from '@apidevtools/swagger-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CONFIG } from '../app/config.token';
import { ContractModule, ContractValidationPipe, createContractDocument, Responds } from './index';

/**
 * The contract as a client sees it: a small application with the real global pipe and the real global serializer, over HTTP. The
 * decorators carry every schema explicitly, so nothing here depends on the metadata a compiler emits.
 */

const KEY = 'sk-made-up-key-0123456789abcdef';

const ItemSchema = z.object({ id: z.string(), count: z.number().int(), note: z.string().nullable() }).meta({ id: 'Item' });
const CreateItemSchema = z
  .object({ name: z.string().min(1), key: z.string().meta({ secret: true }).optional(), count: z.number().int().default(1) })
  .strict()
  .meta({ id: 'CreateItem' });
const ListItemsQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(10).default(5) });

@Controller('items')
class ItemsController {
  @Post()
  @Responds(ItemSchema, { status: 201 })
  create(@Body({ schema: CreateItemSchema }) body: z.infer<typeof CreateItemSchema>): z.input<typeof ItemSchema> {
    return { id: body.name, count: body.count, note: null };
  }

  @Get('wrong')
  @Responds(ItemSchema)
  wrong(): z.input<typeof ItemSchema> {
    return { id: 1, count: 'many' } as never;
  }

  @Get('extra')
  @Responds(ItemSchema)
  extra(): z.input<typeof ItemSchema> {
    return { id: 'a', count: 1, note: null, internal: 'row id 7' } as z.input<typeof ItemSchema>;
  }

  @Get()
  @Responds(ItemSchema, { array: true })
  list(@Query({ schema: ListItemsQuerySchema }) query: z.infer<typeof ListItemsQuerySchema>): z.input<typeof ItemSchema>[] {
    return Array.from({ length: query.limit }, (_, index) => ({ id: String(index), count: index, note: null }));
  }

  @Get('not-declared')
  undeclared(): { whatever: number } {
    return { whatever: 1 };
  }
}

@Module({ controllers: [ItemsController] })
class ItemsModule {}

async function start(dev: boolean): Promise<{ app: INestApplication; url: string }> {
  @Global()
  @Module({ providers: [{ provide: CONFIG, useValue: { dev } }], exports: [CONFIG] })
  class ConfigStub {}
  const module = await Test.createTestingModule({ imports: [ConfigStub, ContractModule, ItemsModule] }).compile();
  const app = module.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  return { app, url: (await app.getUrl()).replace('[::1]', '127.0.0.1') };
}

const post = (url: string, body?: unknown) =>
  fetch(`${url}/items`, { method: 'POST', headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

/** Everything the application printed, by any level. */
function captureLog(): () => string {
  const lines: string[] = [];
  for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => void lines.push(String(message)));
  }
  return () => lines.join('\n');
}

let running: INestApplication | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await running?.close();
  running = undefined;
});

describe('the validation pipe', () => {
  it('answers a wrong body with 400 and the zod path in the message', async () => {
    const { app, url } = await start(true);
    running = app;
    const res = await post(url, { name: '', count: 1.5 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string[]; statusCode: number };
    expect(body.statusCode).toBe(400);
    expect(body.message).toEqual(expect.arrayContaining([expect.stringMatching(/^name: /), expect.stringMatching(/^count: /)]));
  });

  it('refuses a key the schema does not name when the schema is strict', async () => {
    const { app, url } = await start(true);
    running = app;
    const res = await post(url, { name: 'a', extra: true });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string[] }).message.join()).toMatch(/extra|Unrecognized/);
  });

  it('treats a missing body as {} (an action without a payload needs none)', async () => {
    const { app, url } = await start(true);
    running = app;
    const res = await post(url);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string[] }).message).toEqual([expect.stringMatching(/^name: /)]);
  });

  it('leaves a parameter without a schema alone, a missing body included', async () => {
    const pipe = new ContractValidationPipe();
    await expect(pipe.transform(undefined, { type: 'body' })).resolves.toBeUndefined();
    await expect(pipe.transform('x', { type: 'param', data: 'id' })).resolves.toBe('x');
  });

  it('hands the handler the parsed value: defaults applied', async () => {
    const { app, url } = await start(true);
    running = app;
    const res = await post(url, { name: 'a' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'a', count: 1, note: null });
  });

  it('validates the query too, coercing what it should', async () => {
    const { app, url } = await start(true);
    running = app;
    expect(((await (await fetch(`${url}/items?limit=2`)).json()) as unknown[]).length).toBe(2);
    expect(((await (await fetch(`${url}/items`)).json()) as unknown[]).length).toBe(5);
    const bad = await fetch(`${url}/items?limit=99`);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string[] }).message[0]).toMatch(/^limit: /);
  });

  it('logs the paths of a rejection and never the secret a marked field carried', async () => {
    const printed = captureLog();
    const { app, url } = await start(true);
    running = app;
    const res = await post(url, { name: '', key: KEY });
    expect(res.status).toBe(400);
    const log = printed();
    expect(log).toMatch(/Rejected body: name: /);
    expect(log).toContain('[secret]');
    expect(log).not.toContain(KEY);
    expect(JSON.stringify(await res.json())).not.toContain(KEY);
  });

  it('does not log a value it was told nothing about either, when a secret could be among it', async () => {
    const printed = captureLog();
    const { app, url } = await start(true);
    running = app;
    await post(url, { name: 'x', key: 'fine', stray: KEY });
    expect(printed()).not.toContain(KEY);
  });
});

describe('the serializer', () => {
  it('sends what the schema names and nothing else', async () => {
    const { app, url } = await start(true);
    running = app;
    expect(await (await fetch(`${url}/items/extra`)).json()).toEqual({ id: 'a', count: 1, note: null });
  });

  it('answers 500 in development when the handler returns the wrong shape, and logs the paths', async () => {
    const printed = captureLog();
    const { app, url } = await start(true);
    running = app;
    const res = await fetch(`${url}/items/wrong`);
    expect(res.status).toBe(500);
    expect(printed()).toMatch(/GET \/items\/wrong: the response does not match its schema: id: .*count: /);
  });

  it('logs and passes the result through in production', async () => {
    const printed = captureLog();
    const { app, url } = await start(false);
    running = app;
    const res = await fetch(`${url}/items/wrong`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 1, count: 'many' });
    expect(printed()).toMatch(/the response does not match its schema/);
  });

  it('leaves a handler without @Responds alone', async () => {
    const { app, url } = await start(true);
    running = app;
    expect(await (await fetch(`${url}/items/not-declared`)).json()).toEqual({ whatever: 1 });
  });
});

describe('the document', () => {
  async function documentOf(): Promise<ReturnType<typeof createContractDocument>> {
    const { app } = await start(true);
    running = app;
    return createContractDocument(app, [ItemsModule]);
  }

  it('is a valid OpenAPI 3.1 document and lists each schema once as a component', async () => {
    const document = await documentOf();
    expect(document.openapi).toBe('3.1.0');
    await expect(SwaggerParser.validate(structuredClone(document) as never)).resolves.toBeDefined();
    expect(Object.keys(document.components?.schemas ?? {}).sort()).toEqual(['CreateItem', 'Item', 'Problem']);
  });

  it('writes a nullable field the 3.1 way, and the secret mark as writeOnly', async () => {
    const schemas = (await documentOf()).components?.schemas as Record<string, { properties: Record<string, Record<string, unknown>> }>;
    expect(schemas['Item'].properties['note']).toEqual({ type: ['string', 'null'] });
    expect(schemas['CreateItem'].properties['key']).toMatchObject({ type: 'string', writeOnly: true, 'x-secret': true });
    expect(schemas['CreateItem'].properties['key']).not.toHaveProperty('secret');
  });

  it('describes a request by what a client sends and a response by what it gets', async () => {
    const document = await documentOf();
    const schemas = document.components?.schemas as Record<string, { required?: string[] }>;
    expect(schemas['CreateItem'].required).toEqual(['name']); // `count` has a default, so a client may leave it out
    expect(schemas['Item'].required).toEqual(['id', 'count', 'note']);
    const create = document.paths['/items']?.post;
    expect(Object.keys(create?.responses ?? {})).toEqual(['201', '400', '401']); // the success the handler sends, and the two errors every route shares
  });

  it('turns the query schema into query parameters', async () => {
    const list = (await documentOf()).paths['/items']?.get;
    expect(list?.parameters).toEqual([expect.objectContaining({ name: 'limit', in: 'query', required: false })]);
  });

  it('refuses two different schemas under one id', async () => {
    const { app } = await start(true);
    running = app;
    const First = z.object({ a: z.string() }).meta({ id: 'Clash' });
    const Second = z.object({ b: z.string() }).meta({ id: 'Clash2' });
    @Controller('clash')
    class ClashController {
      @Get('one')
      @Responds(First)
      one(): z.input<typeof First> {
        return { a: 'x' };
      }
      @Post('two')
      two(@Body({ schema: Second.meta({ id: 'Clash' }) }) body: unknown): unknown {
        return body;
      }
    }
    @Module({ controllers: [ClashController] })
    class ClashModule {}
    const module = await Test.createTestingModule({ imports: [ClashModule] }).compile();
    const clash = module.createNestApplication({ logger: false });
    await clash.init();
    try {
      expect(() => createContractDocument(clash, [ClashModule])).toThrow(/share the id "Clash"/);
    } finally {
      await clash.close();
    }
  });
});
