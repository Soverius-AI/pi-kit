import 'reflect-metadata';
import { HTTP_CODE_METADATA, METHOD_METADATA, MODULE_METADATA } from '@nestjs/common/constants.js';
import { RequestMethod, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import SwaggerParser from '@apidevtools/swagger-parser';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OpenAPIObject } from '@nestjs/swagger';

/**
 * The document of the real backend: the application module is scanned the way `pnpm run api:openapi` does (`preview`: no provider is
 * created, so no database, keychain or pi folder is touched), and what comes out must be a valid OpenAPI 3.1 document that says what the routes do.
 */

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
const METHODS: Record<number, Method> = { [RequestMethod.GET]: 'get', [RequestMethod.POST]: 'post', [RequestMethod.PUT]: 'put', [RequestMethod.PATCH]: 'patch', [RequestMethod.DELETE]: 'delete' };

let document: OpenAPIObject;
let controllers: Type[];

/** Every controller of the application, found the way Nest finds them: the module tree from the root. The ones that `@ApiExcludeController()` (the AG-UI run endpoint) are not on the contract. */
function controllersOf(root: Type, seen = new Set<Type>()): Type[] {
  if (seen.has(root)) return [];
  seen.add(root);
  const own = ((Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, root) ?? []) as Type[]).filter((controller) => !Reflect.getMetadata('swagger/apiExcludeController', controller));
  const imported = ((Reflect.getMetadata(MODULE_METADATA.IMPORTS, root) ?? []) as Type[]).filter((module) => typeof module === 'function');
  return [...own, ...imported.flatMap((module) => controllersOf(module, seen))];
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'production';
  process.env['PI_KIT_TOKEN'] ??= 'document-spec-token-1234';
  process.env['PI_KIT_PORT'] ??= '4399';
  const { AppModule } = await import('../app/app.module');
  const { createContractDocument } = await import('./document');
  const app = await NestFactory.create(AppModule, { preview: true, abortOnError: false, logger: false });
  app.setGlobalPrefix('api');
  document = createContractDocument(app);
  controllers = controllersOf(AppModule);
}, 60_000);

/** Every route of the controllers on the contract, with what Nest will really answer. */
function routes(): { controller: string; handler: string; method: Method; status: number }[] {
  return controllers.flatMap((controller) =>
    Object.getOwnPropertyNames(controller.prototype)
      .filter((name) => name !== 'constructor' && Reflect.hasMetadata(METHOD_METADATA, controller.prototype[name as keyof object]))
      .map((handler) => {
        const fn = controller.prototype[handler as keyof object];
        const method = METHODS[Reflect.getMetadata(METHOD_METADATA, fn) as number];
        const status = (Reflect.getMetadata(HTTP_CODE_METADATA, fn) as number | undefined) ?? (method === 'post' ? 201 : 200);
        return { controller: controller.name.replace(/Controller$/, ''), handler, method, status };
      }),
  );
}

describe('doc/api/openapi.yaml, as the application builds it', () => {
  it('exposes the local setup directory, search and context as generated-client query parameters', () => {
    const hardware = document.paths['/api/setup/local-runtime/hardware']?.get;
    const models = document.paths['/api/setup/local-runtime/models']?.get;
    expect(hardware?.parameters).toEqual([expect.objectContaining({ name: 'directory', in: 'query', required: false })]);
    expect(models?.parameters).toEqual([
      expect.objectContaining({ name: 'query', in: 'query', required: false }),
      expect.objectContaining({ name: 'contextTokens', in: 'query', schema: expect.objectContaining({ default: 8192, minimum: 512, maximum: 32768 }) }),
    ]);
  });

  it('is a valid OpenAPI 3.1 document', async () => {
    expect(document.openapi).toBe('3.1.0');
    await expect(SwaggerParser.validate(structuredClone(document) as never)).resolves.toBeDefined();
  });

  it('lists every route of the application, once (only the AG-UI run endpoint stays outside)', () => {
    const documented = Object.values(document.paths).flatMap((item) => Object.values(item as Record<string, { operationId: string }>).map((operation) => operation.operationId));
    const actual = routes().map((route) => `${route.controller}_${route.handler}`);
    expect(actual.length).toBeGreaterThanOrEqual(138);
    expect([...documented].sort()).toEqual([...actual].sort());
    expect(new Set(documented).size).toBe(documented.length);
  });

  it('documents the status each handler really sends (the 201 of a POST, the @HttpCode of the others)', () => {
    for (const route of routes()) {
      const operation = Object.values(document.paths)
        .map((item) => (item as Record<string, { operationId: string; responses: Record<string, unknown> }>)[route.method])
        .find((candidate) => candidate?.operationId === `${route.controller}_${route.handler}`);
      const success = Object.keys(operation?.responses ?? {}).filter((code) => code.startsWith('2'));
      expect(success, `${route.controller}.${route.handler}`).toEqual([String(route.status)]);
    }
  });

  it('describes every success: a schema, a stream, a document or nothing at all (204)', () => {
    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item as Record<string, { responses: Record<string, { content?: Record<string, unknown> }> }>)) {
        const code = Object.keys(operation.responses).find((key) => key.startsWith('2'));
        expect(code, `${method} ${path}`).toBeDefined();
        if (code !== '204') expect(Object.keys(operation.responses[code as string].content ?? {}).length, `${method} ${path} answers ${code} without a body`).toBeGreaterThan(0);
      }
    }
  });

  it('documents the errors every route shares, with one Problem body: 401 without the token, 400 for a request that is read', () => {
    const problem = { content: { 'application/json': { schema: { $ref: '#/components/schemas/Problem' } } } };
    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item as Record<string, { security?: unknown[]; requestBody?: unknown; parameters?: { in: string }[]; responses: Record<string, unknown> }>)) {
        const open = operation.security?.length === 0;
        expect(operation.responses['401'] !== undefined, `${method} ${path} 401`).toBe(!open);
        if (operation.requestBody || operation.parameters?.some((parameter) => parameter.in === 'query')) expect(operation.responses['400'], `${method} ${path} 400`).toMatchObject(problem);
        for (const [status, response] of Object.entries(operation.responses)) if (Number(status) >= 400) expect(response, `${method} ${path} ${status}`).toMatchObject(problem);
      }
    }
    expect(document.components?.schemas).toHaveProperty('Problem');
  });

  it('says that the one route without a token has none, and that every other route has one', () => {
    const open = Object.entries(document.paths).flatMap(([path, item]) => Object.entries(item as Record<string, { security?: unknown[] }>).filter(([, operation]) => operation.security?.length === 0).map(([method]) => `${method} ${path}`));
    expect(open.sort()).toEqual(['get /api/genui-sandbox/frame.html', 'get /api/mcp-sandbox/proxy.html']);
  });

  it('says what each operation does, in a sentence, under a tag', () => {
    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item as Record<string, { summary?: string; description?: string; tags?: string[] }>)) {
        expect(operation.summary, `${method} ${path}`).toBeTruthy();
        expect(operation.description, `${method} ${path}`).toMatch(/[.!?]$/);
        expect(operation.tags?.length, `${method} ${path}`).toBeGreaterThan(0);
      }
    }
  });

  it('puts every path under /api and asks for the bearer token', () => {
    expect(Object.keys(document.paths).every((path) => path.startsWith('/api/'))).toBe(true);
    expect(document.security).toEqual([{ bearer: [] }]);
    expect(document.components?.securitySchemes).toHaveProperty('bearer');
  });

  it('documents the status stream as newline-delimited JSON with the schema of one line', () => {
    const events = (document.paths['/api/threads/events'] as unknown as { get: { responses: Record<string, { content: Record<string, { schema: Record<string, unknown> }> }> } }).get;
    const content = events.responses['200'].content['application/x-ndjson'];
    expect(content.schema['x-line-schema']).toEqual({ $ref: '#/components/schemas/ThreadsEvent' });
    expect(document.components?.schemas).toHaveProperty('ThreadsEvent');
  });

  it('writes the same document twice (the check that diffs it needs that)', async () => {
    const { documentToYaml } = await import('./document');
    expect(documentToYaml(document)).toBe(documentToYaml(structuredClone(document)));
  });
});
