import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomSignalTransport, supportedSignalVersion } from './room-signal.transport';
import { SignalCliClient } from './room-signal-client';
import type { PhoneMessage } from './room-phone.types';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const GROUP = Buffer.alloc(32, 7).toString('base64');
const THREAD = `signal:group:${Buffer.from(GROUP, 'base64').toString('base64url')}`;
const CLI = String.raw`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
if(process.argv.includes('--version')){console.log('signal-cli 0.14.10');process.exit(0);}
const dir=process.argv[process.argv.indexOf('--data-dir')+1],mode=JSON.parse(fs.readFileSync(path.join(dir,'test-mode.json'),'utf8'));
const adapter=process.argv.includes('-a'),aci='11111111-1111-4111-8111-111111111111';
const out=value=>process.stdout.write(JSON.stringify(value)+'\n');
fs.appendFileSync(path.join(dir,'requests.jsonl'),JSON.stringify({pid:process.pid,args:process.argv.slice(2)})+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const req=JSON.parse(line);fs.appendFileSync(path.join(dir,'requests.jsonl'),JSON.stringify(req)+'\n');
 const reply=result=>out({jsonrpc:'2.0',id:req.id,result});
 if(req.method==='version'){reply({version:'0.14.10'});if(adapter&&mode.messages)setTimeout(()=>{for(const envelope of mode.messages){if(envelope.timestamp===0){envelope.timestamp=Date.now()+100;envelope.dataMessage.timestamp=envelope.timestamp;}out({jsonrpc:'2.0',method:'receive',params:{account:aci,envelope}});}},200);}
 else if(req.method==='listAccounts')reply(mode.linked||adapter?[{number:null,aci}]:[]);
 else if(req.method==='startLink')reply({deviceLinkUri:'sgnl://linkdevice?uuid=test&pub_key=test'});
 else if(req.method==='finishLink'){if(!mode.hang)setTimeout(()=>reply({number:null,aci}),40);}
 else if(req.method==='listGroups')reply([{id:mode.group,name:'Personal room',description:'',members:[],isMember:true}]);
 else if(req.method==='listContacts')reply([]);
 else if(req.method==='send')reply({timestamp:req.params.timestamp,results:[{type:mode.sendFailure?'NETWORK_FAILURE':'SUCCESS'}]});
 else if(req.method==='getAttachment')reply({data:Buffer.from('hello').toString('base64')});
 else if(req.method==='bad')process.stdout.write('invalid secret-response\n');
 else if(req.method==='hang'){}
 else reply({});
});
`;

let dir: string;
let binary: string;
let transport: RoomSignalTransport;
function mode(value: Record<string, unknown> = {}) {
  writeFileSync(
    join(dir, 'room-signal-auth', 'test-mode.json'),
    JSON.stringify({ linked: true, group: GROUP, ...value }),
  );
}
function requests(): Record<string, unknown>[] {
  return readFileSync(join(dir, 'room-signal-auth', 'requests.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pi-signal-room-'));
  binary = join(dir, 'signal-cli');
  writeFileSync(binary, CLI);
  chmodSync(binary, 0o700);
  mkdirSync(join(dir, 'room-signal-auth'));
  mode();
  transport = new RoomSignalTransport({ dataDir: dir });
  await transport.configure({ binaryPath: binary });
});
afterEach(async () => {
  await transport.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe('Signal room transport with the real community adapter and a fake CLI process', () => {
  it('links a numberless account with QR, keeps provisioning local, and starts the SDK using the ACI', async () => {
    mode({ linked: false });
    await transport.connect();
    expect(transport.phase).toBe('qr');
    expect(transport.qr).toMatch(/^sgnl:\/\/linkdevice\?/);
    await vi.waitFor(() => expect(transport.phase).toBe('connected'), { timeout: 5000 });
    expect(transport.account).toBe(ACCOUNT);
    const logged = requests();
    expect(logged.find((item) => item.method === 'finishLink')?.params).toEqual({
      deviceLinkUri: 'sgnl://linkdevice?uuid=test&pub_key=test',
      deviceName: 'pi-kit Rooms',
    });
    expect(logged.some((item) => Array.isArray(item.args) && item.args.includes(ACCOUNT))).toBe(true);
    expect(
      logged.every((item) => !Array.isArray(item.args) || !item.args.some((arg) => /--http|--tcp/.test(String(arg)))),
    ).toBe(true);
  });
  it('receives group text and attachments through Chat SDK, ignores DMs, own sync and historical input', async () => {
    const env = (timestamp: number, text: string, extra: Record<string, unknown> = {}) => ({
      sourceUuid: OWNER,
      sourceName: 'Owner',
      timestamp,
      dataMessage: { timestamp, message: text, groupInfo: { groupId: GROUP }, ...extra },
    });
    mode({
      messages: [
        env(0, 'remember this', {
          attachments: [{ id: 'file', filename: 'note.txt', contentType: 'text/plain', size: 5 }],
          quote: { id: 123, authorUuid: ACCOUNT },
        }),
        env(1, 'history'),
        {
          sourceUuid: OWNER,
          timestamp: Date.now() + 1000,
          dataMessage: { timestamp: Date.now() + 1000, message: 'DM' },
        },
        { sourceUuid: ACCOUNT, timestamp: Date.now() + 1000, syncMessage: { sentMessage: { message: 'own sync' } } },
      ],
    });
    const receive = vi.fn(async (_message: PhoneMessage) => undefined);
    transport.receive = receive;
    await transport.connect();
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(receive.mock.calls[0]?.[0]).toMatchObject({
      group: THREAD,
      sender: OWNER,
      text: 'remember this',
      quoteId: `${ACCOUNT}:123`,
      files: [{ name: 'note.txt', size: 5 }],
    });
    const raw = (receive.mock.calls[0] as unknown as [{ raw: string }])[0].raw;
    expect(Buffer.from(await transport.media(raw)).toString()).toBe('hello');
    expect(transport.input.ignoredHistory).toBe(1);
  });
  it('sends a reserved identity and native quote through the adapter without changing it on retry', async () => {
    await transport.connect();
    const id = transport.createMessageId();
    expect(await transport.send(THREAD, 'Hello', id, { id: `${OWNER}:123`, sender: OWNER, text: 'Question' })).toBe(id);
    expect(await transport.send(THREAD, 'Hello', id)).toBe(id);
    const sends = requests().filter((item) => item.method === 'send');
    expect(sends).toHaveLength(2);
    expect(sends[0]?.params).toMatchObject({
      account: ACCOUNT,
      groupId: GROUP,
      message: 'Hello',
      timestamp: Number(id.split(':').at(-1)),
      quoteTimestamp: 123,
      quoteAuthor: OWNER,
      quoteMessage: 'Question',
    });
    expect((sends[1]?.params as { timestamp: number }).timestamp).toBe(
      (sends[0]?.params as { timestamp: number }).timestamp,
    );
  });
  it('does not claim success when a recipient fails and does not fabricate delivery/read receipts', async () => {
    mode({ sendFailure: true });
    await transport.connect();
    const receipt = vi.fn(async () => undefined);
    transport.receipt = receipt;
    await expect(transport.send(THREAD, 'Hello', transport.createMessageId())).rejects.toThrow('could not confirm');
    expect(receipt).not.toHaveBeenCalled();
  });
  it('cancels pending QR provisioning and rejects unsupported settings without collecting account keys', async () => {
    mode({ linked: false, hang: true });
    await transport.connect();
    expect(transport.phase).toBe('qr');
    await transport.disconnect();
    expect(transport.phase).toBe('disconnected');
    expect(transport.qr).toBeNull();
    await expect(transport.configure({ accountKey: 'never' })).rejects.toThrow('No account keys');
  });
  it('fences a cancelled provisioning callback from a newer connection', async () => {
    mode({ linked: false, hang: true });
    await transport.connect();
    const stopping = transport.disconnect();
    mode({ linked: true });
    await transport.connect();
    await stopping;
    await vi.waitFor(() => expect(transport.phase).toBe('connected'));
    expect(transport.account).toBe(ACCOUNT);
    expect(transport.error).toBeNull();
  });

  it('provides actionable dependency status when the binary is missing', async () => {
    await transport.configure({ binaryPath: join(dir, 'missing') });
    await expect(transport.connect()).rejects.toThrow('brew install signal-cli');
    expect(transport.details().dependency).toMatchObject({
      available: false,
      error: expect.stringContaining('0.14.10'),
    });
    expect(supportedSignalVersion('signal-cli 0.14.9')).toBe(false);
    expect(supportedSignalVersion('signal-cli 0.14.10')).toBe(true);
  });
  it('bounds RPC waits and redacts malformed process output', async () => {
    const client = new SignalCliClient();
    await client.start(binary, join(dir, 'room-signal-auth'));
    await expect(client.request('hang', {}, 10)).rejects.toThrow('timed out');
    const pending = expect(client.request('hang')).rejects.toThrow('cancelled');
    await client.close();
    await pending;
    const malformed = new SignalCliClient();
    await malformed.start(binary, join(dir, 'room-signal-auth'));
    await expect(malformed.request('bad')).rejects.toThrow('invalid JSON');
    await malformed.close();
  });
});
