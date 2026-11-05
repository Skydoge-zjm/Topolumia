// Synthetic protocol sequences for adapter auditing. This fixture never calls a
// model or executes tools. Claude ordering follows its documented stream flow.
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

const scenario = process.env.TOPOLUMIA_TRACE_AUDIT_CASE;
const wire = process.env.TOPOLUMIA_TRACE_AUDIT_WIRE;
const captureInput = frame => {
  if (process.env.TOPOLUMIA_TRACE_AUDIT_INPUT) appendFileSync(process.env.TOPOLUMIA_TRACE_AUDIT_INPUT, `${JSON.stringify(frame)}\n`);
};
const send = packet => {
  if (wire) appendFileSync(wire, `${JSON.stringify(packet)}\n`);
  process.stdout.write(`${JSON.stringify(packet)}\n`);
};

if (scenario.startsWith('claude-')) {
  const reader = readline.createInterface({ input: process.stdin });
  for await (const line of reader) {
    const frame = JSON.parse(line);
    captureInput(frame);
    if (frame.type === 'control_request') send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
    if (frame.type === 'user') break;
  }
  const session = process.argv[process.argv.indexOf('--session-id') + 1] ?? randomUUID();
  const assistant = (id, content, extra = {}) => send({ type: 'assistant', uuid: randomUUID(), session_id: session,
    parent_tool_use_id: null, message: { id, type: 'message', role: 'assistant', model: 'gpt-6-luna', content,
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } }, ...extra });
  const stream = event => send({ type: 'stream_event', uuid: randomUUID(), session_id: session, parent_tool_use_id: null, event });
  if (scenario === 'claude-image-input') {
    assistant('image-answer', [{ type: 'text', text: 'Image input received.' }]);
  } else if (scenario === 'claude-text-blocks') {
    stream({ type: 'message_start', message: { id: 'native-message' } });
    for (const [index, text] of ['First block. ', 'Second block.'].entries()) {
      stream({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
      assistant('native-message', [{ type: 'text', text }]);
      stream({ type: 'content_block_stop', index });
    }
    stream({ type: 'message_stop' });
  } else if (scenario === 'claude-structured-tools') {
    const call = (id, name, input, output) => {
      assistant(id, [{ type: 'tool_use', id, name, input }]);
      send({ type: 'user', uuid: randomUUID(), session_id: session, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify(output) }] } });
    };
    call('context', 'mcp__topolumia__get_context', {}, { schemaVersion: 'research-brief.v2', project: { name: '科研验证项目' }, counts: { nodes: 3, sources: 1 }, questions: [] });
    call('search', 'mcp__topolumia__search', { query: '种子对照', target: 'nodes' }, { schemaVersion: 'research-search.v2', query: '种子对照', items: [{ id: 'experiment:g1', label: '条件化实验', summary: '使用三个种子进行对照。' }], total: 1, nextCursor: null });
    call('source', 'mcp__topolumia__read_source', { ref: 'file:protocol.md' }, { schemaVersion: 'research-source.v2', source: { ref: 'file:protocol.md', label: '实验协议', version: 'fixture-source-v1' }, text: '# 实验计划\n\n采用三个独立随机种子。\n\n| 组别 | 种子 |\n| --- | --- |\n| G1 | 42 |', range: { start: 0, end: 80, totalChars: 160, nextOffset: 80 } });
    call('external', 'mcp__papers__search', {}, { items: [{ title: 'External result', year: 2026 }] });
    assistant('answer', [{ type: 'text', text: 'Structured tool outputs verified.' }]);
  } else if (scenario === 'claude-subagent') {
    assistant('child-message', [{ type: 'text', text: 'Child report.' }], { parent_tool_use_id: 'agent-call', agent_id: 'task-child' });
    assistant('parent-message', [{ type: 'text', text: 'Parent answer.' }]);
  } else {
    assistant('usage-message', [{ type: 'text', text: 'Usage audit.' }]);
  }
  send({ type: 'result', subtype: 'success', uuid: randomUUID(), session_id: session, duration_ms: 1,
    duration_api_ms: 1, is_error: false, num_turns: 1, result: 'Audit done.', stop_reason: 'end_turn',
    total_cost_usd: 1, modelUsage: {}, permission_denials: [],
    usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 20, cache_read_input_tokens: 100 } });
} else {
  let turn = 0;
  const threadId = 'audit-thread';
  const notice = (method, params) => send({ method, params });
  const completed = id => notice('turn/completed', { threadId, turn: { id, items: [], status: 'completed' } });
  const reader = readline.createInterface({ input: process.stdin });
  reader.on('line', line => {
    const packet = JSON.parse(line);
    captureInput(packet);
    const reply = result => send({ id: packet.id, result });
    if (packet.method === 'initialize') return reply({ userAgent: 'trace-audit-fixture' });
    if (packet.method === 'initialized') return;
    if (packet.method === 'thread/start' || packet.method === 'thread/resume') return reply({ thread: { id: threadId } });
    if (packet.method === 'thread/read') return reply({ thread: { id: threadId } });
    if (packet.method === 'thread/turns/list') return reply({ data: [{ id: packet.params.cursor ? 'later-turn' : 'old-turn', items: [], status: 'completed' }], nextCursor: packet.params.cursor ? null : 'more-turns' });
    if (packet.method === 'thread/items/list') return reply({ data: [], nextCursor: packet.params.cursor ? null : 'more-items' });
    if (packet.method === 'turn/interrupt') { reply({}); setTimeout(() => completed('native-1'), 70); return; }
    if (packet.method !== 'turn/start') return;
    const id = `native-${++turn}`;
    if (scenario === 'codex-id-collision') {
      send({ id: packet.id, method: 'item/commandExecution/requestApproval', params: {
        threadId, turnId: id, itemId: 'command', startedAtMs: Date.now(), command: 'audit-only', reason: 'Fixture approval' } });
      setTimeout(() => reply({ turn: { id, items: [], status: 'inProgress' } }), 15);
      return;
    }
    reply({ turn: { id, items: [], status: 'inProgress' } });
    if (scenario === 'codex-image-input') {
      notice('item/completed', { threadId, turnId: id, item: { type: 'agentMessage', id: `answer-${turn}`, phase: 'final_answer', text: 'Image input received.' } });
      completed(id); return;
    }
    if (scenario === 'codex-stale-completion') {
      if (turn === 2) {
        setTimeout(() => completed('native-1'), 70);
        setTimeout(() => completed(id), 180);
      }
      return;
    }
    if (scenario === 'codex-retry') {
      notice('error', { threadId, turnId: id, willRetry: true, error: { message: 'Transient upstream error', codexErrorInfo: 'serverOverloaded' } });
      setTimeout(() => completed(id), 20);
      return;
    }
    if (scenario === 'codex-plan') {
      notice('item/plan/delta', { threadId, turnId: id, itemId: 'plan', delta: 'Draft plan' });
      notice('item/completed', { threadId, turnId: id, completedAtMs: Date.now(), item: { type: 'plan', id: 'plan', text: 'Revised final plan' } });
    }
    if (scenario === 'codex-compact-tools') {
      const item = value => {
        notice('item/started', { threadId, turnId: id, item: value });
        notice('item/completed', { threadId, turnId: id, item: value });
      };
      item({ type: 'agentMessage', id: 'progress-1', phase: 'commentary', text: '先检查论文和环境。' });
      const command = 'Get-Content -LiteralPath "E:\\papers\\research-notes.md" -Raw\n' + Array.from({ length: 12 }, (_, i) => `Write-Output "材料 ${i + 1}：核对原文与图表来源"`).join('\n');
      item({ type: 'commandExecution', id: 'command-1', status: 'completed', command: `"C:\\Users\\Researcher\\runtime\\powershell\\pwsh.exe" -Command '${command}'`, cwd: 'E:\\papers', exitCode: 0, aggregatedOutput: Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 行：论文原文和图表检查结果。`).join('\n') });
      item({ type: 'commandExecution', id: 'command-2', status: 'completed', command: 'python inspect_paper.py --figures --tables', exitCode: 0, aggregatedOutput: '检查完成：找到关键图表。' });
      for (const suffix of ['a', 'b']) {
        item({ type: 'mcpToolCall', id: `source-${suffix}`, server: 'topolumia', tool: 'read_source', status: 'completed', arguments: { ref: `file:paper-${suffix}.md`, note: Array.from({ length: 30 }, (_, i) => `核对字段 ${i + 1}`).join('\n') }, result: { content: [{ type: 'text', text: JSON.stringify({ schemaVersion: 'research-source.v2', source: { ref: `file:paper-${suffix}.md`, label: `论文材料 ${suffix}` }, text: '# 图表检查结果\n\n' + Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 段：已核对图表来源与实验指标。`).join('\n\n') }) }] } });
      }
      item({ type: 'agentMessage', id: 'progress-2', phase: 'commentary', text: '已核对图表，正在整理结果。' });
      item({ type: 'agentMessage', id: 'answer', phase: 'final_answer', text: '论文与图表检查完成。' });
    }
    if (scenario === 'codex-image-views') {
      const paths = JSON.parse(process.env.TOPOLUMIA_TRACE_AUDIT_IMAGES);
      const image = (file, index) => {
        notice('item/started', { threadId, turnId: id, item: { type: 'imageView', id: `image-${index}`, path: file } });
        notice('item/completed', { threadId, turnId: id, item: { type: 'imageView', id: `image-${index}`, path: file, completedAtMs: Date.now() } });
      };
      paths.slice(0, 6).forEach(image);
      notice('item/completed', { threadId, turnId: id, item: { type: 'agentMessage', id: 'progress', phase: 'commentary', text: '已查看六张图像，继续核对其余材料。' } });
      image(paths[6], 6);
      notice('item/completed', { threadId, turnId: id, item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: '图像检查完成。' } });
    }
    completed(id);
  });
}
