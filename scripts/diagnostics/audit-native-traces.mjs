// Read-only adapter audit: runs synthetic native wire producers, not models.
// Run `npm run build:backend` first. Optional Codex schema validation uses a
// bundle generated locally by the installed CLI (see the audit report).
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { ClaudeCliStreamDriver } from '../../dist/src/adapters/agents/claude/claude-cli-stream-driver.js';
import { CodexAppServerDriver } from '../../dist/src/adapters/agents/codex/codex-app-server-driver.js';
import { JsonlProcess } from '../../dist/src/adapters/agents/shared/jsonl-process.js';
import { OpenCodeTrace } from '../../dist/src/adapters/agents/opencode/opencode-trace.js';
import { OpenCodeAgentAdapter } from '../../dist/src/adapters/agents/opencode/opencode-agent-adapter.js';
import { AgentSessionGateway } from '../../dist/src/services/agents/agent-session-gateway.js';
import { compactConversationEvents } from '../../dist/src/domain/agents/agent-conversation.js';

const root = path.resolve('runtime/trace-audit');
await mkdir(root, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), 'topolumia-trace-audit-'));
const fixture = path.resolve('fixtures/trace-audit/native-wire.mjs');
const findings = [];
const validators = {};
try {
  const ajv = new Ajv({ strict: false, validateFormats: false });
  for (const name of ['ServerNotification', 'ServerRequest']) validators[name] = ajv.compile(JSON.parse(await readFile(path.join(root, 'codex-schema', `${name}.json`), 'utf8')));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const checkedFrames = [];
async function checkWire(file) {
  const lines = (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  for (const packet of lines) {
    if (!packet.method) continue;
    const name = packet.id === undefined ? 'ServerNotification' : 'ServerRequest';
    const validate = validators[name];
    if (validate && !validate(packet)) throw new Error(`Invalid fixture ${packet.method}: ${JSON.stringify(validate.errors)}`);
    checkedFrames.push({ method: packet.method, validated: Boolean(validate) });
  }
}
const nativeProfile = (scenario, provider) => ({ id: scenario, provider, label: 'Trace audit fixture', command: process.execPath,
  ...(provider === 'claude' ? { launcherArgs: [fixture] } : { args: [fixture] }),
  env: { TOPOLUMIA_TRACE_AUDIT_CASE: scenario, TOPOLUMIA_TRACE_AUDIT_WIRE: path.join(temporary, `${scenario}.jsonl`) } });
async function gatewayCase(scenario, provider) {
  const profile = nativeProfile(scenario, provider);
  const Driver = provider === 'claude' ? ClaudeCliStreamDriver : CodexAppServerDriver;
  const gateway = new AgentSessionGateway({ profileRegistry: { createAdapter: async (_id, options) => new Driver(profile, { ...options, requestTimeoutMs: 3000 }) } });
  try {
    const session = await gateway.create({ profileId: scenario });
    // Explicit snapshot auditing is separate from the live decoder cases.
    gateway.sessions.get(session.id).capabilities.session.sync = false;
    gateway.startTurn(session.id, { text: 'Audit fixture' });
    for (let i = 0; i < 300; i++) {
      const current = gateway.snapshot(session.id);
      if (current.turns[0]?.completedAt) return current;
      await delay(10);
    }
    throw new Error(`Fixture did not settle: ${scenario}`);
  } finally {
    await gateway.closeAll();
    if (provider === 'codex') await checkWire(profile.env.TOPOLUMIA_TRACE_AUDIT_WIRE);
  }
}
function record(id, provider, expected, actual, reproduced) {
  findings.push({ id, provider, expected, actual, reproduced });
}
try {
  const claude = await gatewayCase('claude-text-blocks', 'claude');
  const text = claude.conversationEvents.filter(e => e.type === 'assistant.message.completed').map(e => e.payload.text).join('');
  record('CLAUDE_TEXT_BLOCK_OVERWRITE', 'claude', 'First block. Second block.', text, text !== 'First block. Second block.');
  const subagent = await gatewayCase('claude-subagent', 'claude');
  const child = subagent.conversationEvents.find(e => e.payload.text === 'Child report.');
  record('CLAUDE_SUBAGENT_ATTRIBUTION', 'claude', { agentId: 'task-child', parentToolUseId: 'agent-call' },
    { agentId: child?.payload.agentId ?? null, parentToolUseId: child?.payload.parentToolUseId ?? null, topLevelAssistant: Boolean(child) && !child.payload.agentId && !child.payload.parentToolUseId },
    child?.payload.agentId !== 'task-child' || child?.payload.parentToolUseId !== 'agent-call');
  const usageSession = await gatewayCase('claude-usage', 'claude');
  const usage = usageSession.events.find(e => e.type === 'usage.updated').payload.tokenUsage.last;
  record('CLAUDE_CACHE_USAGE_LOSS', 'claude', { allInputAndOutputTokens: 132, cachedRead: 100, cacheCreation: 20 }, usage,
    usage.totalTokens !== 132 || usage.cachedInputTokens !== 100 || usage.cacheWriteInputTokens !== 20);
  const retry = await gatewayCase('codex-retry', 'codex');
  record('CODEX_RETRY_ABORTS_TURN', 'codex', { status: 'completed', retryObserved: true },
    { status: retry.turns[0].status, retryObserved: retry.events.some(e => e.type === 'turn.retrying') }, retry.turns[0].status !== 'completed' || !retry.events.some(e => e.type === 'turn.retrying'));
  const plan = await gatewayCase('codex-plan', 'codex');
  const planEvents = plan.conversationEvents.filter(e => e.type === 'plan.updated');
  record('CODEX_FINAL_PLAN_IGNORED', 'codex', 'Revised final plan', planEvents.map(e => e.payload), !JSON.stringify(planEvents).includes('Revised final plan'));

  const profile = nativeProfile('codex-id-collision', 'codex');
  const requests = [];
  const transport = new JsonlProcess({ command: profile.command, args: profile.args, cwd: temporary, env: profile.env,
    onMessage: packet => requests.push(packet), requestTimeoutMs: 2000 });
  try {
    await transport.start();
    await transport.request('initialize', { clientInfo: { name: 'audit', version: '1' } }); transport.notify('initialized', {});
    const response = await transport.request('turn/start', { threadId: 'audit-thread', input: [{ type: 'text', text: 'audit' }] });
    await delay(40);
    record('CODEX_BIDIRECTIONAL_ID_COLLISION', 'codex', { turnId: 'native-1', serverRequests: 1 },
      { turnId: response?.turn?.id ?? null, serverRequests: requests.filter(p => p.method).length }, response?.turn?.id !== 'native-1' || requests.filter(p => p.method).length !== 1);
  } finally { await transport.kill(); await checkWire(profile.env.TOPOLUMIA_TRACE_AUDIT_WIRE); }

  const staleProfile = nativeProfile('codex-stale-completion', 'codex');
  const driver = new CodexAppServerDriver(staleProfile, { requestTimeoutMs: 50 });
  try {
    await driver.start({ cwd: temporary });
    const firstTurn = driver.prompt({ turnId: 'local-1', content: [{ type: 'text', text: 'first' }] });
    await delay(70);
    driver.cancel();
    await firstTurn;
    driver.requestTimeoutMs = 2000;
    const result = await driver.prompt({ turnId: 'local-2', content: [{ type: 'text', text: 'second' }] });
    record('CODEX_STALE_TURN_COMPLETION', 'codex', 'native-2', result.nativeTurnId, result.nativeTurnId !== 'native-2');
    const snapshot = await driver.readSnapshot();
    record('CODEX_SNAPSHOT_NOT_PAGINATED', 'codex', { noRemainingCursors: true, turnCount: 2 },
      { nextTurns: snapshot.turns.nextCursor, nextItems: snapshot.items.nextCursor, turnCount: snapshot.turns.data.length }, Boolean(snapshot.turns.nextCursor || snapshot.items.nextCursor || snapshot.turns.data.length !== 2));
  } finally { await driver.close(); await checkWire(staleProfile.env.TOPOLUMIA_TRACE_AUDIT_WIRE); }

  const events = [];
  const trace = new OpenCodeTrace(e => events.push(e), () => 'local-turn');
  const info = { id: 'assistant', sessionID: 'session', role: 'assistant', parentID: 'user', modelID: 'audit', providerID: 'audit', mode: 'build', agent: 'build',
    time: { created: 1 }, path: { cwd: temporary, root: temporary }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
  const part = { id: 'text', messageID: info.id, sessionID: info.sessionID, type: 'text', text: 'Partial', time: { start: 1 } };
  trace.message(info); trace.part(part);
  trace.message({ ...info, time: { created: 1, completed: 3 } });
  trace.replay([{ info: { ...info, time: { created: 1, completed: 3 } }, parts: [{ ...part, text: 'Full authoritative answer', time: { start: 1, end: 2 } }] }]);
  const projected = compactConversationEvents(events.map((e, i) => ({ ...e, id: `event-${i}`, cursor: i, sessionId: 'session', occurredAt: '' })));
  const finalText = projected.find(e => e.type === 'assistant.message.completed')?.payload.text;
  record('OPENCODE_FINISHED_SNAPSHOT_IGNORED', 'opencode', 'Full authoritative answer', finalText, finalText !== 'Full authoritative answer');

  const deltaEvents = [];
  const adapter = new OpenCodeAgentAdapter({ id: 'audit', label: 'audit', provider: 'opencode' }, { onEvent: e => deltaEvents.push(e) });
  adapter.nativeSessionId = 'session'; adapter.turn = { id: 'local-turn', userMessageId: 'user' };
  adapter.handleEvent({ id: 'message-event', type: 'message.updated', properties: { sessionID: 'session', info } });
  adapter.handleEvent({ id: 'part-event', type: 'message.part.updated', properties: { sessionID: 'session', part: { ...part, text: '' }, time: 1 } });
  const delta = { id: 'stable-native-event', type: 'message.part.delta', properties: { sessionID: 'session', messageID: info.id, partID: part.id, field: 'text', delta: 'hello' } };
  adapter.handleEvent(delta); adapter.handleEvent(delta);
  const replayText = deltaEvents.filter(e => e.type === 'assistant.message.delta').map(e => e.payload.delta).join('');
  record('OPENCODE_NATIVE_EVENT_REPLAY_DUPLICATES', 'opencode', 'hello', replayText, replayText !== 'hello');

  const hashes = {};
  for (const file of ['src/adapters/agents/shared/agent-driver.ts', 'src/adapters/agents/shared/jsonl-process.ts', 'src/adapters/agents/codex/codex-app-server-driver.ts', 'src/adapters/agents/codex/codex-reasoning.ts', 'src/adapters/agents/claude/claude-cli-stream-driver.ts', 'src/adapters/agents/opencode/opencode-trace.ts', 'src/adapters/agents/opencode/opencode-agent-adapter.ts', 'src/domain/agents/agent-conversation.ts', 'src/adapters/agents/claude/claude-trace.ts', 'src/domain/agents/agent-usage.ts', 'src/services/agents/agent-session-gateway.ts']) {
    hashes[file] = createHash('sha256').update(await readFile(file)).digest('hex');
  }
  const compiledHashes = {};
  for (const file of ['dist/src/adapters/agents/shared/agent-driver.js', 'dist/src/adapters/agents/shared/jsonl-process.js', 'dist/src/adapters/agents/codex/codex-app-server-driver.js', 'dist/src/adapters/agents/codex/codex-reasoning.js', 'dist/src/adapters/agents/claude/claude-cli-stream-driver.js', 'dist/src/adapters/agents/opencode/opencode-trace.js', 'dist/src/adapters/agents/opencode/opencode-agent-adapter.js']) {
    compiledHashes[file] = createHash('sha256').update(await readFile(file)).digest('hex');
  }
  const report = { schemaVersion: 'native-trace-audit.v1', generatedAt: new Date().toISOString(),
    method: 'Synthetic official-format sequences against the current compiled adapters; no model inference, user-session changes, or real tool execution.',
    schemaValidation: { codexFrames: checkedFrames.length, passed: checkedFrames.filter(f => f.validated).length },
    sourceHashes: hashes, compiledHashes, findings };
  await writeFile(path.join(root, 'reproduction-results.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (process.argv.includes('--assert-fixed') && findings.some(f => f.reproduced)) process.exitCode = 1;
} finally { await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
