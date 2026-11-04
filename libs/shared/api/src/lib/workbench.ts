import { InjectionToken } from '@angular/core';
import { z } from 'zod';
import type { BackendConnection } from './backend.service';

const InstanceIdSchema = z.uuid();

export const WorkbenchSelectionSchema = z
  .object({
    instanceId: InstanceIdSchema,
    cwd: z.string().min(1).max(4096).optional(),
    threadId: z.string().min(1).max(512).optional(),
  })
  .strict();
export type WorkbenchSelection = z.infer<typeof WorkbenchSelectionSchema>;
export interface WorkbenchContext {
  readonly entryId?: string;
  readonly ownerId?: string;
  readonly remote: boolean;
  readonly selection?: WorkbenchSelection;
}
let context: Readonly<WorkbenchContext> = Object.freeze({ remote: false });
let configured = false;
/** Set exactly once before bootstrap. Switching execution owners creates a new document/workbench, never mutates a live connector. */
export function configureWorkbench(value: WorkbenchContext): void {
  if (configured) throw new Error('A live workbench cannot change execution owner.');
  configured = true;
  context = Object.freeze({
    ...value,
    ...(value.selection ? { selection: Object.freeze({ ...value.selection }) } : {}),
  });
}
export const currentWorkbench = (): Readonly<WorkbenchContext> => context;
export const isLocalExecution = (): boolean => !context.remote;
export const WORKBENCH = new InjectionToken<Readonly<WorkbenchContext>>('WORKBENCH', {
  providedIn: 'root',
  factory: currentWorkbench,
});
export const ENTRY_CONNECTION = new InjectionToken<BackendConnection>('ENTRY_CONNECTION');
export function readWorkbenchFragment(hash: string): WorkbenchSelection | undefined {
  try {
    const value = new URLSearchParams(hash.slice(1)).get('workbench');
    return value ? WorkbenchSelectionSchema.parse(JSON.parse(value)) : undefined;
  } catch {
    return undefined;
  }
}
export function workbenchFragment(value: WorkbenchSelection): string {
  return '#' + new URLSearchParams({ workbench: JSON.stringify(WorkbenchSelectionSchema.parse(value)) });
}
export function scopedBackendConnection(entry: BackendConnection, ownerId: string): BackendConnection {
  const target = InstanceIdSchema.parse(ownerId);
  return Object.freeze({
    mode: entry.mode,
    token: () => entry.token(),
    resume: () => entry.resume?.() ?? Promise.resolve(),
    url: async () => `${(await entry.url()).replace(/\/$/, '')}/api/instances/${target}/proxy`,
  });
}
