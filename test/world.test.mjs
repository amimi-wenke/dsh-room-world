import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createService } from '../lib/service.js';
test('chat inherits adapter persona/memory/current room; desktop has no QQ send path', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-chat-')); t.after(() => fs.rmSync(dir, { recursive: true }));
  let id = 'role-a', calls = 0, prompt;
  const service = createService({ stateDir: dir, planner: { enabled: false },
    adapter: { context: async () => ({ id, name: '测试鱼', persona: '原人格', memory: '原记忆' }), messages: async () => [{ key: 'private:1', ownerQQ: '1', role: 'user', text: '去吃白米饭', messageId: 'qq-1', at: Date.now() }] },
    complete: async options => { calls++; prompt = options.system; return JSON.stringify({ text: '我在看书呢。', roomAction: null }); },
  });
  await service.refresh(); await service.sync();
  assert.equal(service.room.updateRoom({ activity: 'read', phase: 'day', position: { x: 50, y: 70 }, autonomous: true }).ok, true);
  const result = await service.chat('在做什么', 'request-1');
  assert.ok(prompt.includes('原人格') && prompt.includes('原记忆') && prompt.includes('正在看书') && prompt.includes('去吃白米饭'));
  assert.equal(result.reply.text, '我在看书呢。');
  await service.chat('在做什么', 'request-1'); assert.equal(calls, 1);
  assert.equal(service.room.events(0).events.length, 1);
  await service.tool({ target: 'room', action: 'rice' }); assert.equal(service.commands(0).events.at(-1).action, 'rice');
  id = 'role-b'; await service.refresh(); assert.equal(service.history().messages.length, 0); assert.equal(service.room.room().online, false);
});

test('chat history is flattened into the system prompt; every request sends a single user message', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-chat-history-')); t.after(() => fs.rmSync(dir, { recursive: true }));
  const seen = [];
  const service = createService({ stateDir: dir, planner: { enabled: false },
    adapter: { context: async () => ({ id: 'role-a', name: 'x', persona: 'p', memory: 'm' }) },
    complete: async options => { seen.push(options); return JSON.stringify({ text: 'reply ' + seen.length, roomAction: null }); },
  });
  await service.refresh();
  await service.chat('first', 'r1');
  await service.chat('second', 'r2');
  assert.equal(seen.length, 2);
  for (const options of seen) {
    assert.equal(options.messages.length, 1, 'history must not be replayed as chat turns');
    assert.equal(options.messages[0].role, 'user');
  }
  assert.ok(!seen[0].system.includes('最近的桌面对话'), 'nothing to quote before the first reply');
  assert.ok(seen[1].system.includes('最近的桌面对话'));
  assert.ok(seen[1].system.includes('主人：first') && seen[1].system.includes('你：reply 1'));
});
test('character switching while LLM is pending cancels reply and actions', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-switch-')); t.after(() => fs.rmSync(dir, { recursive: true }));
  let id = 'a', resolve;
  const pending = new Promise(r => { resolve = r; });
  const s = createService({ stateDir: dir, adapter: { context: async () => ({ id, persona: id }) }, complete: async () => pending });
  const chat = s.chat('hello', 'r1'); await new Promise(r => setTimeout(r, 10)); id = 'b';
  resolve('{"text":"hello","roomAction":"sleep"}'); await assert.rejects(chat, /人格已切换/);
  assert.equal(s.commands(0).events.length, 0); assert.equal(s.history().messages.length, 0);
});
test('screenshot move/go_home calls return home, stop outdoor auto, and observing never moves', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-return-')); t.after(() => fs.rmSync(dir, { recursive: true }));
  const s = createService({ stateDir: dir, adapter: { context: async () => ({ id: 'a', persona: 'a' }) }, complete: async () => '' });
  await s.refresh();
  await s.tool({ target: 'world', action: 'visit', area: 'farm' });
  await s.tool({ target: 'world', action: 'auto', enabled: true });
  const before = s.commands(0).cursor;
  assert.equal((await s.tool({ target: 'world', action: 'observe' })).ok, true);
  assert.equal(s.commands(0).cursor, before, 'observe and auto must not enqueue extra doorway actions');
  const move = await s.tool({ target: 'world', action: 'move', area: 'room' });
  assert.equal(move.ok, true); assert.equal(move.world.location, 'room'); assert.equal(move.world.autonomous, false);
  assert.equal(s.commands(0).events.at(-1).action, 'home');
  await s.tool({ target: 'world', action: 'visit', area: 'garden' });
  const home = await s.tool({ target: 'room', action: 'go_home' });
  assert.equal(home.ok, true); assert.equal(home.command.action, 'home');
  assert.equal(s.world().world.location, 'room', 'room home must also update world location');
  const invalid = await s.tool({ target: 'world', action: 'teleport_elsewhere' });
  assert.equal(invalid.ok, false); assert.equal(invalid.code, 'WORLD_ACTION_INVALID'); assert.ok(invalid.hint);
  const missing = await s.tool({ target: 'world', action: 'move' });
  assert.equal(missing.code, 'WORLD_AREA_REQUIRED'); assert.ok(missing.hint);
  assert.equal((await s.tool({ target: 'room', action: 'nonexistent' })).code, 'ROOM_ACTION_INVALID');
});
