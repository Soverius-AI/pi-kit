import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calculateJwkThumbprint } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PeerIdentitySchema, type PeerIdentity, type ReviewComment } from '@pi-kit/protocol';
import { AttendantRepository } from './attendant.repository';
import { ChangesRepository } from './changes.repository';
import { DatabaseService } from './database.service';
import { InstanceRepository } from './instance.repository';
import { LeasesRepository } from './leases.repository';
import { MetaRepository } from './meta.repository';
import { PeersRepository } from './peers.repository';
import { SkillDraftsRepository } from './skill-drafts.repository';

let dir: string;
let db: DatabaseService;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pk-async-repositories-'));
  db = await DatabaseService.create({ dataDir: dir });
});
afterEach(async () => {
  await db.onApplicationShutdown();
  rmSync(dir, { recursive: true, force: true });
});
const comment = (id: string): ReviewComment => ({
  id,
  file: 'file.ts',
  side: 'new',
  line: 1,
  snippet: 'line',
  text: id,
});
async function identity(): Promise<PeerIdentity> {
  const publicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
  return PeerIdentitySchema.parse({
    instanceId: randomUUID(),
    name: 'Peer',
    origin: 'https://peer.fixture.ts.net',
    protocolVersion: 1,
    publicKey,
    fingerprint: await calculateJwkThumbprint(publicKey),
  });
}

describe('async repository atomicity', () => {
  it('returns each rename snapshot, not a later queued write, with synchronous immutable ownership', async () => {
    const instance = new InstanceRepository(db),
      meta = new MetaRepository(db);
    const owner = instance.instanceId;
    const [first, second] = await Promise.all([instance.rename('First'), instance.rename('Second')]);
    expect(first.name).toBe('First');
    expect(second.name).toBe('Second');
    expect(instance.instanceId).toBe(owner);
    expect(meta.instanceId).toBe(owner);
  });

  it('waits for every comment insert and rolls back an entire failed replacement', async () => {
    const changes = new ChangesRepository(db);
    await changes.replaceComments('t', [comment('original')]);
    await db.db.exec(
      "CREATE TRIGGER reject_comment BEFORE INSERT ON review_comments WHEN NEW.id = 'bad' BEGIN SELECT RAISE(ABORT, 'bad comment'); END",
    );
    await expect(changes.replaceComments('t', [comment('first'), comment('bad')])).rejects.toThrow('bad comment');
    expect(await changes.comments('t')).toEqual([comment('original')]);
    await Promise.all([
      changes.replaceComments('t', [comment('a'), comment('b')]),
      changes.replaceComments('t', [comment('c')]),
    ]);
    expect(await changes.comments('t')).toEqual([comment('c')]);
  });

  it('keeps concurrent lease renewals and metadata marks from losing the first write', async () => {
    const leases = new LeasesRepository(db),
      meta = new MetaRepository(db);
    const [first, second] = await Promise.all([leases.take('t', '/p', 'f', 100), leases.take('t', '/p', 'f', 200)]);
    expect(first.since).toBe(100);
    expect(second).toMatchObject({ since: 100, at: 200 });
    await Promise.all([meta.markLearningThread('a', 'one'), meta.markLearningThread('b', 'two')]);
    await Promise.all([meta.markVerificationThread('a', 'draft-a'), meta.markVerificationThread('b', 'draft-b')]);
    expect(await meta.learningThreads()).toEqual({ a: 'one', b: 'two' });
    expect(await meta.verificationThreads()).toEqual({ a: 'draft-a', b: 'draft-b' });
  });

  it('returns each draft edit snapshot without dropping concurrent edits of other fields', async () => {
    const drafts = new SkillDraftsRepository(db);
    const draft = await drafts.insert({
      threadId: 't',
      name: 'old',
      text: 'old text',
      scope: 'project',
      madeBy: 'person',
    });
    const [first, second] = await Promise.all([
      drafts.edit(draft.id, { name: 'new' }),
      drafts.edit(draft.id, { text: 'new text' }),
    ]);
    expect(first).toMatchObject({ name: 'new', text: 'old text' });
    expect(second).toMatchObject({ name: 'new', text: 'new text' });
  });

  it('maintains one open suggestion per target and rolls back dismissal on failed insertion', async () => {
    const attendant = new AttendantRepository(db);
    const suggestion = { threadId: 't', kind: 'prompt' as const, target: 'same', text: 'first' };
    await Promise.all([
      attendant.addSuggestion(suggestion),
      attendant.addSuggestion({ ...suggestion, text: 'second' }),
    ]);
    expect(await attendant.openSuggestions('t')).toMatchObject([{ text: 'second' }]);
    await db.db.exec(
      "CREATE TRIGGER reject_suggestion BEFORE INSERT ON thread_suggestions WHEN NEW.text = 'bad' BEGIN SELECT RAISE(ABORT, 'bad suggestion'); END",
    );
    await expect(attendant.addSuggestion({ ...suggestion, text: 'bad' })).rejects.toThrow('bad suggestion');
    expect(await attendant.openSuggestions('t')).toMatchObject([{ text: 'second' }]);
  });

  it('serializes pinned peer identity checks and confirmation guards with their writes', async () => {
    const peers = new PeersRepository(db),
      peer = await identity(),
      pair = randomUUID();
    const outcomes = await Promise.allSettled([
      peers.remember(peer, pair, false, false, 'pending', false, 'inviter'),
      peers.remember(
        { ...peer, origin: 'https://changed.fixture.ts.net' },
        pair,
        false,
        false,
        'pending',
        false,
        'inviter',
      ),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'rejected']);
    const confirmations = await Promise.allSettled([
      peers.confirmation(peer.instanceId, pair, '123456'),
      peers.confirmation(peer.instanceId, pair, '654321'),
    ]);
    expect(confirmations.map((o) => o.status)).toEqual(['fulfilled', 'rejected']);
    expect(await peers.get(peer.instanceId)).toMatchObject({ identity: peer, confirmationCode: '123456' });
    await peers.revoke(peer.instanceId, false);
    await expect(peers.remember(peer, pair, false, false, 'active', false, 'inviter')).rejects.toThrow('reactivated');
  });

  it('enforces the device limit atomically when concurrent approvals arrive', async () => {
    const instance = new InstanceRepository(db);
    const approvals = await Promise.allSettled(
      Array.from({ length: 21 }, (_, index) =>
        instance.saveDevice({
          id: randomUUID(),
          name: 'Device',
          cookieHash: index.toString(16).padStart(64, '0'),
          csrf: 'b'.repeat(43),
          createdAt: 100,
          lastSeenAt: 100,
        }),
      ),
    );
    expect(approvals.filter((result) => result.status === 'fulfilled')).toHaveLength(20);
    expect(approvals.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await instance.devices()).toHaveLength(20);
  });

  it('binds one protected key even when competing first binds arrive together', async () => {
    const peers = new PeersRepository(db),
      first = await identity(),
      second = await identity();
    const results = await Promise.allSettled([
      peers.bindKey({ publicKey: first.publicKey, fingerprint: first.fingerprint }),
      peers.bindKey({ publicKey: second.publicKey, fingerprint: second.fingerprint }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(await peers.key()).toEqual({ publicKey: first.publicKey, fingerprint: first.fingerprint });
  });
});
