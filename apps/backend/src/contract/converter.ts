import type { SwaggerDocumentOptions } from '@nestjs/swagger';
import { z } from 'zod';

export type SchemaConverter = NonNullable<SwaggerDocumentOptions['standardSchemaConverter']>;

const isZod = (schema: unknown): schema is z.ZodType => typeof schema === 'object' && schema !== null && '_zod' in schema;

/**
 * Turns a zod schema into the JSON Schema an OpenAPI 3.1 document embeds. Swagger 12 asks for it whenever a route names a schema
 * (`@Body({ schema })`, `@Query({ schema })`, `@Responds(schema)`): it hands over the schema and whether it describes what a client sends
 * (`input`) or what the backend answers (`output`; they differ for `.default()` and transforms).
 *
 * A schema with `.meta({ id })` becomes a component of its own (`#/components/schemas/<id>`), referenced wherever it is nested; without an id it is
 * written inline. Swagger's own conversion of a standard schema asks for the OpenAPI 3.0 dialect (`nullable: true`), which is not valid in a 3.1
 * document, so zod's JSON Schema (2020-12, the dialect 3.1 is built on) is passed through instead.
 *
 * One converter serves one document: it remembers each component it hands out and refuses a second, different one under the same id. The one difference it
 * allows is the one every object has between the two directions: a response is closed (`additionalProperties: false`, the serializer strips what the schema does
 * not name), a request is not (a client may send more and the pipe drops it). A schema used in both directions is one component, written closed, as the response has it.
 */
export function createZodConverter(): SchemaConverter {
  const components = new Map<string, { text: string; loose: string; definition: unknown }>();
  return (schema, { schemaType }) => {
    if (!isZod(schema)) return undefined;
    const json = z.toJSONSchema(schema, { io: schemaType }) as Record<string, unknown> & { $defs?: Record<string, unknown> };
    const { $defs } = json;
    const root = { ...json };
    delete root['$schema'];
    delete root['$defs'];
    const defs: Record<string, unknown> = {};
    for (const [name, definition] of Object.entries($defs ?? {})) {
      const text = JSON.stringify(definition);
      const loose = JSON.stringify(definition, (key, value) => (key === 'additionalProperties' && value === false ? undefined : value));
      const known = components.get(name);
      if (known !== undefined && known.loose !== loose) {
        throw new Error(`Two different schemas share the id "${name}" (seen as ${schemaType}): each needs an id of its own. A default or a transform makes a request and its response differ, which counts.`);
      }
      // The closed form wins, whichever direction asked first.
      const keep = known && (known.text.length >= text.length || schemaType === 'input') ? known : { text, loose, definition };
      components.set(name, keep);
      defs[name] = keep.definition;
    }
    return { schema: root, components: defs };
  };
}
