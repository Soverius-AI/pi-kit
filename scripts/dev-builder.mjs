// Own a desktop development builder and report actual readiness over IPC, without guessing ports or parsing terminal output.
import nx from '@nx/devkit';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Even a killed launcher must not leave an orphan server holding a port or watching the workspace.
process.once('disconnect', () => process.exit(0));

// Angular also accepts the generic PORT variable. Desktop development uses its own explicit override, or port 0.
const role = process.argv[2] ?? 'renderer';
if (!['renderer', 'backend'].includes(role)) throw new Error('Expected renderer or backend.');
if (role === 'renderer') delete process.env.PORT;
const root = process.cwd();
const projectGraph = await nx.createProjectGraphAsync();
const context = {
  root,
  cwd: root,
  projectGraph,
  projectsConfigurations: nx.readProjectsConfigurationFromProjectGraph(projectGraph),
  nxJsonConfiguration: nx.readJsonFile(join(root, 'nx.json')),
  isVerbose: false,
};
// runExecutor runs one executor; Nx's CLI builds its dependency targets first. Keep that work in
// Nx so its normal transitive dependency ordering and cache still apply to the backend's watch build.
if (role === 'backend') {
  const projects = context.projectsConfigurations.projects;
  const dependencies = [...new Set(projectGraph.dependencies.backend.map(({ target }) => target))]
    .filter((name) => projects[name]?.targets?.build);
  if (dependencies.length) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.resolve('nx/bin/nx.js')), 'run-many', '-t', 'build', '--projects', dependencies.join(',')], { stdio: 'inherit' });
    const stop = () => child.kill('SIGTERM');
    process.once('exit', stop);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.exit(0));
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    process.off('exit', stop);
    if (code !== 0) process.exit(code ?? 1);
  }
}
const results = await nx.runExecutor(
  role === 'renderer'
    ? { project: 'renderer', target: 'serve', configuration: 'development' }
    : { project: 'backend', target: 'build', configuration: 'development' },
  role === 'renderer' ? { port: Number(process.env.PI_KIT_DEV_RENDERER_PORT ?? 0), host: 'localhost' } : { watch: true },
  context,
);
let announced = false;
for await (const result of results) {
  if (announced || !result.success || (role === 'renderer' && !result.baseUrl)) continue;
  announced = true;
  process.send?.({ type: `${role}-ready`, ...(role === 'renderer' ? { url: new URL(result.baseUrl).origin } : {}) }, () => undefined);
}
// A dev server should keep watching; an ended executor must also stop the other development processes.
process.exit(1);
