import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { runProcess } from './process-runner';

describe('managed process groups', () => {
  it.skipIf(process.platform === 'win32')('stops descendants even when the group leader exits before an uncooperative child', async () => {
    const controller = new AbortController();
    let childPid: number | undefined;
    let leaderPid: number | undefined;
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const descendant = `process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000);`;
    const script = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','pipe','ignore']});child.stdout.once('data',()=>process.stdout.write('child='+child.pid+'\\n'));setInterval(()=>{},1000);`;
    const running = runProcess({ command: process.execPath, args: ['-e', script], processGroup: true, signal: controller.signal,
      onStart: (pid) => { leaderPid = pid; },
      onLine: (line) => { if (line.startsWith('child=')) { childPid = Number(line.slice(6)); ready(); } },
    });
    try {
      await Promise.race([started, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('The owned child did not become ready.')), 3000).unref())]);
      expect(leaderPid).toBeGreaterThan(0);
      expect(childPid).toBeGreaterThan(0);
      controller.abort();
      expect((await running).cancelled).toBe(true);
      let status = '';
      try { status = execFileSync('ps', ['-o', 'stat=', '-p', String(childPid)], { encoding: 'utf8' }).trim(); } catch { /* no live process */ }
      expect(!status || status.startsWith('Z')).toBe(true);
    } finally {
      controller.abort();
      if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch { /* already gone */ } }
      await running;
    }
  });
});
