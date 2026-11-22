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

/** Apps offered first in the Composio dialog; any other toolkit slug can be typed. */
export const COMPOSIO_POPULAR_APPS: readonly { toolkit: string; name: string }[] = [
  { toolkit: 'gmail', name: 'Gmail' },
  { toolkit: 'outlook', name: 'Outlook' },
  { toolkit: 'googlecalendar', name: 'Google Calendar' },
  { toolkit: 'googledrive', name: 'Google Drive' },
  { toolkit: 'googlesheets', name: 'Google Sheets' },
  { toolkit: 'googledocs', name: 'Google Docs' },
  { toolkit: 'slack', name: 'Slack' },
  { toolkit: 'microsoft_teams', name: 'Microsoft Teams' },
  { toolkit: 'notion', name: 'Notion' },
  { toolkit: 'github', name: 'GitHub' },
  { toolkit: 'linear', name: 'Linear' },
  { toolkit: 'jira', name: 'Jira' },
  { toolkit: 'hubspot', name: 'HubSpot' },
  { toolkit: 'asana', name: 'Asana' },
  { toolkit: 'trello', name: 'Trello' },
  { toolkit: 'dropbox', name: 'Dropbox' },
  { toolkit: 'onedrive', name: 'OneDrive' },
  { toolkit: 'zoom', name: 'Zoom' },
  { toolkit: 'calendly', name: 'Calendly' },
  { toolkit: 'airtable', name: 'Airtable' },
  { toolkit: 'salesforce', name: 'Salesforce' },
  { toolkit: 'zendesk', name: 'Zendesk' },
  { toolkit: 'discord', name: 'Discord' },
  { toolkit: 'figma', name: 'Figma' },
];

const ToolkitSlugSchema = z.string().regex(/^[a-z0-9_-]{1,64}$/);

export const ComposioAppSchema = z
  .object({
    toolkit: ToolkitSlugSchema,
    name: z.string(),
    connected: z.boolean(),
    /** Composio's page to connect the app, while it is not connected. */
    signInUrl: z.string().nullable(),
    error: z.string().nullable(),
  })
  .meta({ id: 'ComposioApp' });
export type ComposioApp = z.infer<typeof ComposioAppSchema>;

export const ComposioConnectSchema = z
  .object({
    /** Its name in the user mcp.json. */
    server: z.string().nullable(),
    signedIn: z.boolean(),
    /** Why the apps could not be checked. */
    problem: z.string().nullable(),
    apps: z.array(ComposioAppSchema),
  })
  .meta({ id: 'ComposioConnect' });
export type ComposioConnect = z.infer<typeof ComposioConnectSchema>;

export const ComposioWireRequestSchema = z
  .object({ toolkit: ToolkitSlugSchema, name: z.string().trim().min(1).max(200) })
  .strict()
  .meta({ id: 'ComposioWireRequest' });
export type ComposioWireRequest = z.infer<typeof ComposioWireRequestSchema>;

export const ComposioSearchQuerySchema = z.object({ q: z.string().trim().min(1).max(200) }).strict();

export const ComposioFoundAppSchema = z
  .object({ toolkit: ToolkitSlugSchema, name: z.string(), description: z.string() })
  .meta({ id: 'ComposioFoundApp' });
export type ComposioFoundApp = z.infer<typeof ComposioFoundAppSchema>;
export const ComposioFoundAppListSchema = z.array(ComposioFoundAppSchema).meta({ id: 'ComposioFoundAppList' });
