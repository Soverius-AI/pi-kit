import { z } from 'zod';

export const ComposioStatusSchema = z
  .object({
    configured: z.boolean(),
    storage: z.enum(['keychain', 'plain']).nullable(),
  })
  .meta({ id: 'ComposioStatus' });
export type ComposioStatus = z.infer<typeof ComposioStatusSchema>;

export const ComposioKeyRequestSchema = z
  .object({ apiKey: z.string().trim().min(8).max(512).meta({ secret: true }) })
  .strict()
  .meta({ id: 'ComposioKeyRequest' });

export const ComposioToolkitsQuerySchema = z.object({ search: z.string().max(100).optional() }).strict();

export const ComposioToolkitSchema = z
  .object({
    slug: z.string(),
    name: z.string(),
    description: z.string(),
    logo: z.string().nullable(),
    tools: z.number().int().nonnegative(),
    noAuth: z.boolean(),
  })
  .meta({ id: 'ComposioToolkit' });
export type ComposioToolkit = z.infer<typeof ComposioToolkitSchema>;
export const ComposioToolkitListSchema = z.array(ComposioToolkitSchema).meta({ id: 'ComposioToolkitList' });

export const ComposioAddRequestSchema = z
  .object({
    toolkit: z.string().regex(/^[a-z0-9_-]{1,64}$/),
    name: z.string().min(1).max(200),
    readOnly: z.boolean().default(true),
  })
  .strict()
  .meta({ id: 'ComposioAddRequest' });
export type ComposioAddRequest = z.infer<typeof ComposioAddRequestSchema>;

export const ComposioConnectionSchema = z
  .object({
    server: z.string(),
    toolkit: z.string(),
    name: z.string(),
    readOnly: z.boolean(),
    connected: z.boolean(),
    signInUrl: z.string().nullable(),
  })
  .meta({ id: 'ComposioConnection' });
export type ComposioConnection = z.infer<typeof ComposioConnectionSchema>;
export const ComposioConnectionListSchema = z.array(ComposioConnectionSchema).meta({ id: 'ComposioConnectionList' });
