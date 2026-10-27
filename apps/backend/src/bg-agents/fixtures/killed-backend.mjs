// The backend that gets killed in bg-agents.service.spec.ts: it opens the agents store of `dir` with `key`,
// spawns one agent in edit mode whose first tool call is a `bash` that sleeps, prints READY <agent id> once the call's cleanup intent
// is recorded, and keeps running until the spec sends SIGKILL. The TypeScript sources are loaded through jiti (pi's extension loader), so
// the same service code runs here as in the backend; Nest is not started, the service is built by hand as the spec builds its own.
import { createJiti } from 'jiti';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';

const [dir, key, command] = process.argv.slice(2);
const root = new URL('../../../../../', import.meta.url).pathname;
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: {
    '@pi-kit/protocol': `${root}libs/shared/protocol/src/index.ts`,
    '@pi-kit/secret-store': `${root}libs/shared/secret-store/src/index.ts`,
    '@pi-kit/pi-adapter': `${root}libs/shared/pi-adapter/src/index.ts`,
  },
});
const { DatabaseService } = await jiti.import('../../db/database.service.ts');
const { EventLogRepository } = await jiti.import('../../db/event-log.repository.ts');
const { BgAgentsRepository } = await jiti.import('../bg-agents.repository.ts');
const { BgAgentRunner } = await jiti.import('../bg-agent-runner.ts');
const { BgAgentsService } = await jiti.import('../bg-agents.service.ts');

setInterval(() => undefined, 1000); // a waiting Harness holds no handle of its own; the backend's server does this
const database = new DatabaseService({ dataDir: dir }, { key });
const agents = new BgAgentsRepository(database);
const service = new BgAgentsService({ dataDir: dir }, database, agents, { cwdOf: () => dir, deliver: async () => undefined, allowed: async () => undefined, isolate: async () => { throw new Error('no worktrees here'); }, discard: async () => undefined }, new BgAgentRunner(new EventLogRepository(database)));
const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage([fauxToolCall('bash', { command })], { stopReason: 'toolUse' }), fauxAssistantMessage('Done in the first process.')]);
await service.open(models);
const row = await service.spawn({ threadId: 't1', name: 'tester', role: 'tester', brief: 'Run the command.', permission: 'edit', model: `${faux.getModel().provider}/${faux.getModel().id}` });
for (;;) {
  if (agents.get(row.id)?.cleanup) break;
  await new Promise((resolve) => setTimeout(resolve, 25));
}
process.stdout.write(`READY ${row.id}\n`);
