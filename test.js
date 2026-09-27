import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';

const CORDIS_PATH = 'file:///C:/Users/Skibedee%20Ohio%20Rizler/.dsh/profiles/node_modules/@deepseek-ai/cordis/lib/index.js';
const YAML_PATH = 'file:///C:/Users/Skibedee%20Ohio%20Rizler/.dsh/profiles/node_modules/js-yaml/index.js';
const INCLUDE_PATH = 'file:///C:/Users/Skibedee%20Ohio%20Rizler/.dsh/profiles/node_modules/@deepseek-ai/cordis-plugin-include/lib/index.js';

const { Context } = await import(CORDIS_PATH);
const { load } = await import(YAML_PATH);
const { entryListSchema } = await import(INCLUDE_PATH);
const yoloPlugin = await import('./lib/index.js');

console.log('Running YOLO mode test suite...');

// Test 1: Verify presets YAML structure
console.log('1. Checking preset YAML structure...');
const presetMeta = load(readFileSync('presets/yolo/preset.yml', 'utf8'));
assert.strictEqual(presetMeta.name, 'YOLO mode');
assert.ok(presetMeta.description);

const agentCordis = load(readFileSync('presets/yolo/agent.cordis.yml', 'utf8'), { schema: entryListSchema });
assert.ok(Array.isArray(agentCordis));
assert.ok(agentCordis.length > 10);
const personaRow = agentCordis.find(r => r.id === 'persona');
assert.ok(personaRow);
assert.ok(personaRow.config.prefix.includes('YOLO mode'));
console.log('   Preset YAML valid.');

// Test 2: Auto-accepts approval requests
console.log('2. Testing auto-accept on approval/request...');
{
  process.env.DSH_YOLO = '1';
  const app = new Context();
  await app.plugin(yoloPlugin);

  let approved = null;
  const req = {
    agent: { id: 'test-agent' },
    toolName: 'pwsh',
    reason: 'test escalation'
  };

  const outcome = await app.waterfall('approval/request', req, () => 'rejected');
  assert.strictEqual(outcome, 'allowed-once', 'Should return allowed-once');
  console.log('   Approval auto-accepted: allowed-once.');
}

// Test 3: Auto-accepts user-questions / plan reviews
console.log('3. Testing auto-accept on user-questions/request...');
{
  process.env.DSH_YOLO = '1';
  const app = new Context();
  await app.plugin(yoloPlugin);

  // Plan review question
  const planReq = {
    agent: { id: 'test-agent' },
    questions: [
      {
        id: 'plan-1',
        question: 'Approve plan?',
        intent: { kind: 'plan-review', approve: 'Approve' },
        options: [{ label: 'Approve' }, { label: 'Reject' }]
      }
    ]
  };
  const planAnswer = await app.waterfall('user-questions/request', planReq, () => null);
  assert.deepStrictEqual(planAnswer.answers, [{ id: 'plan-1', selected: ['Approve'] }]);
  console.log('   Plan review auto-approved.');

  // Generic menu question with Recommended option
  const menuReq = {
    agent: { id: 'test-agent' },
    questions: [
      {
        id: 'choice-1',
        question: 'Choose mode',
        options: [
          { label: 'Option A (Recommended)' },
          { label: 'Option B' }
        ]
      }
    ]
  };
  const menuAnswer = await app.waterfall('user-questions/request', menuReq, () => null);
  assert.deepStrictEqual(menuAnswer.answers, [{ id: 'choice-1', selected: ['Option A (Recommended)'] }]);
  console.log('   Menu question auto-answered with Recommended option.');
}

// Test 4: Auto-continue on failure
console.log('4. Testing auto-continue on failure...');
{
  process.env.DSH_YOLO = '1';
  const app = new Context();
  await app.plugin(yoloPlugin);

  let sentMessage = null;
  const mockAgent = {
    id: 'agent-test',
    status: 'idle',
    session: { id: 'session-test', seq: 5 },
    followup(msg) {
      sentMessage = msg;
    }
  };

  // Simulate turn/start
  app.emit('agent/created', { agent: mockAgent });
  app.emit('session/event', mockAgent.session, { type: 'turn/start', data: { turn: 1 } });

  // Simulate a tool failure
  app.emit('session/event', mockAgent.session, {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'Command exited with [exit code: 1]' }
        ]
      }
    }
  });

  // Simulate turn/end completed (with unhandled tool failure)
  app.emit('session/event', mockAgent.session, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } }
  });

  // Agent transitions to idle
  app.emit('agent/status', { agent: mockAgent, status: 'idle' });

  // Wait for the 100ms timeout
  await new Promise(r => setTimeout(r, 200));

  assert.ok(sentMessage, 'Expected continue message to be sent');
  assert.strictEqual(sentMessage.role, 'user');
  assert.strictEqual(sentMessage.content[0].text, 'continue');
  console.log('   Continue message auto-sent on tool failure.');
}

// Test 5: Verify user abortion does NOT auto-continue
console.log('5. Testing user abort does NOT auto-continue...');
{
  process.env.DSH_YOLO = '1';
  const app = new Context();
  await app.plugin(yoloPlugin);

  let sentMessage = null;
  const mockAgent = {
    id: 'agent-test-abort',
    status: 'idle',
    session: { id: 'session-test-abort', seq: 2 },
    followup(msg) {
      sentMessage = msg;
    }
  };

  app.emit('agent/created', { agent: mockAgent });
  app.emit('session/event', mockAgent.session, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'aborted' } }
  });

  app.emit('agent/status', { agent: mockAgent, status: 'idle' });

  await new Promise(r => setTimeout(r, 200));

  assert.strictEqual(sentMessage, null, 'Should NOT auto-continue when aborted');
  console.log('   User abort respected, no continue message sent.');
}

console.log('ALL TESTS PASSED!');
