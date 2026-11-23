import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('installed WhatsApp adapter socket contract', () => {
  it('routes live messages through the SDK without a same-account bypass and uses stable provider IDs', () => {
    // An isolated Node loader replaces only the socket constructor. The installed patched adapter,
    // message parser and Baileys utilities run unchanged; no network or credentials are used.
    const script = `
      import assert from 'node:assert/strict';
      import {registerHooks} from 'node:module';
      const baileysURL=import.meta.resolve('baileys');
      let event;
      const sends=[];
      globalThis.phoneSocket={user:{id:'owner:12@s.whatsapp.net'},
        ev:{process:callback=>{event=callback;}},end:()=>{},
        sendMessage:async(jid,body,options)=>{sends.push({jid,body,options});return {key:{id:options.messageId,remoteJid:jid,fromMe:true},message:body};}};
      const substitute='export * from '+JSON.stringify(baileysURL)+';export default ()=>globalThis.phoneSocket;';
      registerHooks({resolve(specifier,context,next){
        if(specifier==='baileys'&&context.parentURL?.includes('chat-adapter-baileys'))return {url:'data:text/javascript,'+encodeURIComponent(substitute),shortCircuit:true};
        return next(specifier,context);
      }});
      const {createBaileysAdapter}=await import('chat-adapter-baileys');
      const external=[];const batches=[];
      const logger={debug:()=>{},info:()=>{},warn:()=>{},error:()=>{},child(){return this;}};
      const adapter=createBaileysAdapter({version:[2,3000,1],logger,
        auth:{state:{creds:{},keys:{get:async()=>({}),set:async()=>{}}},saveCreds:async()=>{}},
        onMessageBatch:batch=>batches.push(batch)});
      await adapter.initialize({getLogger:()=>logger,processMessage:(_adapter,thread,parse)=>{external.push({thread,parse});}});
      await adapter.connect();
      const input={key:{id:'manual-id',remoteJid:'private@g.us',fromMe:true},message:{conversation:'hello room'},messageTimestamp:1234};
      await event({'messages.upsert':{type:'append',messages:[input]}});
      assert.equal(external.length,0);
      await event({'messages.upsert':{type:'notify',messages:[{...input,key:{...input.key,remoteJid:'direct@s.whatsapp.net'}}]}});
      assert.equal(external.length,1);
      await event({'messages.upsert':{type:'notify',messages:[input]}});
      assert.equal(external.length,2);const parsedOwn=await external[1].parse();assert.equal(parsedOwn.raw.key.fromMe,true);assert.equal(parsedOwn.raw.messageTimestamp,1234);
      await event({'messages.upsert':{type:'notify',messages:[{...input,key:{...input.key,fromMe:false,participant:'other@lid'}}]}});
      assert.equal(external.length,3);assert.equal((await external[2].parse()).author.userId,'other@lid');
      assert.deepEqual(batches[0],{type:'append',groups:1,ownGroups:1});
      const group=adapter.encodeThreadId({jid:'private@g.us'});
      const result=await adapter.sendText(group,'reply','reserved-id',{id:'manual-id',sender:'owner@s.whatsapp.net',text:'hello room'});
      assert.equal(result.id,'reserved-id');assert.equal(sends[0].options.messageId,'reserved-id');
      assert.equal(sends[0].options.quoted.key.id,'manual-id');
      await adapter.reply(group,'manual-id','SDK reply');assert.equal(sends[1].options.quoted.key.id,'manual-id');
      const {Chat}=await import('chat');const {createMemoryState}=await import('@chat-adapter/state-memory');
      const received=[];const chat=new Chat({userName:'assistant',adapters:{whatsapp:adapter},state:createMemoryState(),logger});
      chat.onNewMessage(/./s,async(_thread,message)=>{received.push(message.id);});await chat.initialize();
      await event({'messages.upsert':{type:'notify',messages:[{...input,key:{...input.key,id:'sdk-input',fromMe:false,participant:'owner@lid'}}]}});
      for(let attempt=0;attempt<100&&!received.length;attempt++)await new Promise(resolve=>setTimeout(resolve,5));
      assert.deepEqual(received,['sdk-input']);await chat.shutdown();
      await adapter.disconnect();
      process.stdout.write('adapter-contract-passed');
    `;
    expect(
      execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000 }),
    ).toContain('adapter-contract-passed');
  });
});
