import { ApiParam } from '@nestjs/swagger';

/**
 * The path parameters several controllers share, described once. Used as a class or a method decorator:
 * `@ThreadIdParam()` over a controller whose routes are all `threads/:id/...`.
 */

/** `:id` of `threads/:id`. */
export const ThreadIdParam = () => ApiParam({ name: 'id', description: 'The thread id (the pi session id).', schema: { type: 'string' } });

/** `:id` of `workspaces/:id`. */
export const WorkspaceIdParam = () =>
  ApiParam({ name: 'id', description: "The project's folder, URL-encoded (a project has no other id).", schema: { type: 'string' } });
