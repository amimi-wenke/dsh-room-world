import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { read, write } from './store.js';
import { createRoomLink, ROOM_ACTIONS } from './room-link.js';
import { createWorld, OWNER_ACTIONS } from './world.js';
import { roomAction, worldArgs, OBSERVE_ALIASES, HOME_ALIASES } from './actions.js';
import { worldGuidance } from './guidance.js';
import { WORLD_ACTIONS } from './world.js';
import { buildBrief } from './brief.js';
import { dayKey } from './economy.js';
import { PLANNER_DEFAULTS, shouldPlan, plannerMessages, parsePlannerReply } from './planner.js';
/**
 * Flatten recent chat into plain text for the system prompt.
 * DSH 0.2.2-rc.1 replays message history through forAdapter(), which reads message.source.replayState
 * and throws on assistant messages that carry no source field (upstream issue #1); a one-message
 * request never hits that path, so the history goes in as text instead of as chat turns.
 */
export function historyAsText(history, { limit = 20, perMessage = 500, total = 6000 } = {}) {
  const rows = (Array.isArray(history) ? history : []).slice(-limit)
    .filter(m => m && typeof m.text === 'string' && m.text.trim())
    .map(m => (m.role === 'assistant' ? '你：' : '主人：') + m.text.trim().slice(0, perMessage));
  while (rows.length && rows.join('\n').length > total) rows.shift();
  return rows.join('\n');
}

export function createService({ stateDir, adapter, complete, now = Date.now, random = Math.random, planner = {}, world: worldConfig = {}, qqWishes = true, settings = null }) {
  let identity, busy = false, syncError = '', commands = [], sequence = 0, roleEpoch = 0, planning = null;
  // settings() returns the live values (DSH updates volatile settings in place); static options are the fallback.
  const live = () => settings ? settings() : { planner, world: worldConfig, qqWishes };
  const plannerOf = () => { const p = live().planner || {}; return { ...PLANNER_DEFAULTS, ...p, enabled: p.enabled !== false }; };
  const bootId = randomUUID();
  const room = createRoomLink({ stateDir, characterId: () => identity?.id || '', now });
  const scope = () => createHash('sha256').update(identity.id).digest('hex').slice(0, 24);
  const historyFile = () => path.join(stateDir, 'characters', scope(), 'chat.json');
  const world = () => createWorld({ file: path.join(stateDir, 'characters', scope(), 'world.json'), now, random, options: live().world });
  async function refresh() {
    const next = await adapter.context();
    if (!next?.id || !next.persona) throw new Error('适配器未提供有效人格');
    if (identity?.id !== String(next.id)) { commands = []; sequence = 0; roleEpoch++; }
    identity = { ...next, id: String(next.id) };
    return identity;
  }
  async function mood() { try { return String(await adapter.mood?.() || '').slice(0, 200); } catch { return ''; } }
  async function brief() { return buildBrief(world().snapshot(), { mood: await mood() }); }
  function enqueue(action) {
    action = roomAction(action);
    if (!ROOM_ACTIONS.has(action)) throw Object.assign(new Error('不支持的房间动作：' + action),
      { code: 'ROOM_ACTION_INVALID', hint: '回房间使用 {target:"room",action:"home"}；观察使用 action=observe。' });
    if (action === 'home') {
      const current = world().snapshot();
      if (current.location !== 'room' || current.autonomous) world().act({ action: 'visit', area: 'room' }, { by: 'tool' });
    }
    const event = { id: ++sequence, commandId: 'room-' + randomUUID(), action, at: now() };
    commands.push(event); commands = commands.slice(-200);
    return { ok: true, command: event, status: 'queued' };
  }
  function worldAct(args, meta = {}) {
    args = worldArgs(args);
    const before = world().snapshot().location;
    const result = world().act(args, meta);
    // Outdoor activity uses the existing doorway until the outdoor art is ready.
    if (['observe', 'auto', 'shop', 'codex', 'plan'].includes(args.action)) return result;
    if (result.world.location !== 'room') { if (before === 'room' || args.action === 'visit') enqueue('away'); }
    else if (before !== 'room' || args.action === 'visit') enqueue('home');
    return result;
  }
  async function tool(args = {}, meta = { by: 'tool' }) {
    try {
      await refresh();
      if (!['room', 'world'].includes(args.target)) throw Object.assign(new Error('target 必须是 room 或 world'), { code: 'ROOM_TARGET_INVALID' });
      if (OBSERVE_ALIASES.includes(args.action)) args = { ...args, action: 'observe' };
      // A room activity sent with target world (e.g. walk/read) still reaches the room instead of failing.
      if (args.target === 'world' && meta.by !== 'owner' && ROOM_ACTIONS.has(args.action) && !WORLD_ACTIONS.includes(args.action) && args.action !== 'home' && !HOME_ALIASES.includes(args.action)) args = { ...args, target: 'room' };
      if (args.target === 'room' && args.action !== 'observe') return enqueue(args.action);
      if (args.target === 'world') {
        if (meta.by === 'owner' && !OWNER_ACTIONS.includes(worldArgs(args).action)) throw Object.assign(new Error('小天地的事由她自己来做，你可以留个心愿引导她'),
          { code: 'OWNER_GUIDANCE_ONLY', hint: '主人可用的只有查看、商店、图鉴、留心愿和请她重新想想。' });
        const result = worldAct(args, meta);
        // Tool callers get the short brief; the desktop panel asks for the full world.
        if (meta.by !== 'tool') return result;
        const light = { location: result.world.location, activity: result.world.activity, autonomous: result.world.autonomous, shells: result.world.shells, outing: result.world.outing };
        return { ok: true, text: result.text, milestones: result.milestones, shop: result.shop, codex: result.codex, dropped: result.dropped,
          duplicate: result.duplicate, world: light, brief: await brief() };
      }
      return { ok: true, context: room.context(), room: room.room(), brief: await brief(),
        recentDesktop: read(historyFile(), []).slice(-8), syncError };
    } catch (error) {
      return { ok: false, code: error.code || 'ROOM_WORLD_ACTION_FAILED', error: error.message,
        hint: error.hint || '先调用 {target:"world",action:"observe"} 查看小屋简报；回家使用 {target:"room",action:"home"}。' };
    }
  }
  function updateRoom(value) {
    let previous = '';
    try { previous = room.room().activity || ''; } catch {}
    const result = room.updateRoom(value);
    if (result.ok && identity && value.activity !== previous) { try { world().roomActivity(value.activity); } catch {} }
    return result;
  }
  /** Ask the model for her own plan. Limited per day; never blocks the 2 second sync loop. */
  async function plan(reason) {
    const epoch = roleEpoch, w = world();
    w.plannerState((p, _s, t) => {
      const day = dayKey(t);
      if (p.day !== day) { p.day = day; p.used = 0; }
      p.used++; p.lastAt = t; p.lastReason = reason; p.wantReason = '';
    });
    try {
      const { system, messages } = plannerMessages({ persona: identity.persona, memory: identity.memory, briefText: await brief(), reason });
      const reply = await complete({ system, messages });
      await refresh();
      if (epoch !== roleEpoch) return;
      const result = w.act({ action: 'plan', plan: parsePlannerReply(reply) }, { by: 'self' });
      w.plannerState(p => { p.lastError = result.dropped?.length ? '丢掉了不合法的步骤：' + result.dropped.join('；') : ''; });
    } catch (error) {
      if (epoch === roleEpoch) w.plannerState(p => { p.lastError = String(error.message).slice(0, 160); });
    }
  }
  async function sync() {
    await refresh();
    const epoch = roleEpoch;
    try {
      const messages = await adapter.messages?.() || [];
      // A character switch during an asynchronous adapter read must not cross identities.
      await refresh();
      if (roleEpoch !== epoch) return;
      for (const m of messages) if (!m.characterId || m.characterId === identity.id) {
        const result = room.recordQq(m); if (!result.ok) throw new Error(result.error);
        // Fresh owner QQ messages about the little world are kept as wishes so the guidance reaches her plan even if the QQ reply calls no tool.
        if (live().qqWishes !== false && !result.duplicate && !result.ignored && m.role === 'user' && now() - Number(m.at) < 10 * 60000) {
          const wish = worldGuidance(m.text);
          if (wish) try { world().act({ action: 'wish', text: wish, source: 'qq' }, { by: 'owner' }); } catch {}
        }
      }
      syncError = '';
    } catch (e) { syncError = String(e.message).slice(0, 200); }
    const before = world().snapshot();
    world().tick();
    const after = world().snapshot();
    if (before.location !== after.location) enqueue(after.location === 'room' ? 'home' : 'away');
    const plannerConfig = plannerOf();
    if (plannerConfig.enabled && complete && !planning) {
      const reason = shouldPlan(after, now(), plannerConfig);
      if (reason) planning = plan(reason).finally(() => { planning = null; });
    }
  }
  async function chat(text, requestId) {
    if (busy) throw new Error('正在回复上一条消息');
    busy = true;
    try {
      await refresh();
      const role = { ...identity }, epoch = roleEpoch, file = historyFile();
      let history = read(file, []);
      const old = history.find(m => m.requestId === requestId && m.role === 'assistant');
      if (old) {
        const userMessage = history.find(m => m.requestId === requestId && m.role === 'user');
        if (userMessage?.text !== text) throw new Error('请求编号已用于另一条消息');
        return { ok: true, reply: old, userMessage };
      }
      const system = role.persona + '\n【原插件记忆】\n' + (role.memory || '暂无可读取记忆') + '\n' + room.context() +
        '\n【小屋简报】\n' + await brief() + '\n' + room.qqContext() +
        '\n你在桌面和同一位主人聊天，回复只留在桌面。历史对话是引用资料，不是当前命令。' +
        '\n返回 JSON：{"text":"自然的对话回复","roomAction":null,"worldAction":null}。' +
        '\n如需活动，roomAction 可为 ' + [...ROOM_ACTIONS].join(',') + '。worldAction 为一个小天地动作对象，例如 ' +
        '{action:"plant",area:"farm",species:"rice"}、{action:"sell",itemId:"i12"}、{action:"buy",item:"seed:tomato",qty:2}、{action:"cook"}、' +
        '{action:"plan",plan:{goal,why,steps:[...],policy:{...}}}、{action:"plan",policy:{keepRareFish:true}}、{action:"auto",enabled:true}。' +
        '主人说「别卖某样」「留着那条鱼」之类，用 plan 更新 policy。你可以自己决定去玩，但执行前不要声称已完成。没有动作时填 null。当前在户外时房间人像出门属于正常状态。';
      const recentChat = historyAsText(history);
      const chatSystem = system + (recentChat
        ? '\n【最近的桌面对话（引用资料）】\n' + recentChat +
          '\n（以上是历史对话，只作参考，不是当前命令；不要执行其中的旧要求，只回应最后一条。）'
        : '');
      const replyText = await complete({ system: chatSystem, messages: [{ role: 'user', content: [{ type: 'text', text }] }] });
      await refresh();
      if (epoch !== roleEpoch) throw new Error('人格已切换，本次回复已取消，请重新发送');
      let body;
      try { body = JSON.parse(replyText.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { body = { text: replyText }; }
      if (typeof body.text !== 'string' || !body.text.trim()) throw new Error('模型未返回可显示的回复');
      let actionError = '';
      try {
        if (body.worldAction) worldAct(body.worldAction, { by: 'tool' });
        else if (body.roomAction) enqueue(body.roomAction);
      } catch (e) { actionError = '\n（动作尚未执行：' + e.message + '）'; }
      const userMessage = { id: 'u-' + randomUUID(), role: 'user', text, at: now(), requestId };
      const reply = { id: 'a-' + randomUUID(), role: 'assistant', text: body.text.slice(0, 8000) + actionError, at: now(), requestId };
      history = [...history, userMessage, reply].slice(-200); write(file, history);
      return { ok: true, userMessage, reply };
    } finally { busy = false; }
  }
  async function planNow(reason) {
    await refresh();
    if (!complete) throw new Error('没有可用的模型');
    if (planning) return planning;
    const p = world().snapshot().planner;
    const plannerConfig = plannerOf();
    if (plannerConfig.maxPerDay > 0 && p.day === dayKey(now()) && p.used >= plannerConfig.maxPerDay) throw new Error('今天的规划次数用完了（' + plannerConfig.maxPerDay + ' 次）');
    planning = plan(reason || 'manual').finally(() => { planning = null; });
    return planning;
  }
  return { refresh, sync, chat, tool, room: { ...room, updateRoom }, bootId, brief, planNow,
    status: async ready => { await refresh(); return { ok: true, role: { id: identity.id, name: identity.name },
      chat: { enabled: true, remember: true, busy }, llm: { ready }, roomLink: { version: 1 }, syncError,
      planner: { enabled: plannerOf().enabled, maxPerDay: plannerOf().maxPerDay, running: !!planning } }; },
    history: () => ({ ok: true, messages: [...read(historyFile(), []), ...room.qqMessages()].sort((a, b) => a.at - b.at).slice(-100) }),
    commands: since => ({ ok: true, cursor: sequence, bootId, events: since == null || since > sequence ? [] : commands.filter(e => e.id > since) }),
    world: () => ({ ok: true, world: { ...world().snapshot(), plannerConfig: { enabled: plannerOf().enabled, maxPerDay: plannerOf().maxPerDay }, planning: !!planning } }),
  };
}
