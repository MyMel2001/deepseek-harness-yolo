import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let createUserMsg = null;
try {
  const llm = await import('@deepseek-ai/dsh-llm');
  createUserMsg = llm.createUserMessage;
} catch {
  // Fallback if import fails
}

function makeContinueMessage() {
  if (createUserMsg) {
    return createUserMsg({
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'user' },
    });
  }
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: 'continue' }],
    source: { kind: 'user' },
  };
}

const kYoloEnabled = Symbol('dsh.yolo.enabled');
const MAX_CONSECUTIVE_CONTINUES = 10;
const agentStates = new WeakMap();
const explicitYoloSessions = new Set();

function getAgentState(agent) {
  let state = agentStates.get(agent);
  if (!state) {
    state = {
      shouldContinue: false,
      lastToolFailed: false,
      continueCount: 0,
      lastFailureReason: null,
    };
    agentStates.set(agent, state);
  }
  return state;
}

function isYoloAgent(ctx, agent) {
  if (process.env.DSH_YOLO === '1' || process.env.DSH_YOLO === 'true') {
    return true;
  }
  if (!agent) return false;

  const session = agent.session;
  if (session && explicitYoloSessions.has(session.id)) {
    return true;
  }

  // Check preset from agentPresets service
  try {
    const presets = ctx.get('agentPresets');
    if (presets) {
      const presetId = presets.composedPreset(agent.ctx);
      if (presetId === 'yolo') return true;
    }
  } catch {}

  // Check session header
  if (session) {
    if (session.header?.agentPreset === 'yolo') return true;
    try {
      if (typeof session.seq === 'number') {
        const start = Math.max(0, session.seq - 30);
        for (let seq = session.seq - 1; seq >= start; seq -= 1) {
          const ev = session.eventAt?.(seq);
          if (ev?.type === 'agent-preset/selected' && ev.data?.agentPreset === 'yolo') {
            return true;
          }
        }
      }
    } catch {}
  }

  return false;
}

function checkToolFailure(data) {
  if (!data) return false;
  if (data.error) return true;
  const msg = data.message;
  if (msg && Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.isError) return true;
      if (block.type === 'text' && typeof block.text === 'string') {
        const text = block.text;
        const exitMatch = /\[exit code:\s*(\d+)\]/i.exec(text);
        if (exitMatch && exitMatch[1] !== '0') return true;
        if (/\[sandbox:\s*file access denied/i.test(text)) return true;
        if (/Error:\s*tool call timed out/i.test(text)) return true;
      }
    }
  }
  return false;
}

function syncPresetFiles(logger) {
  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
    const targetDir = join(dshHome, '.agent-presets', 'yolo');
    const srcDir = join(__dirname, '..', 'presets', 'yolo');

    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    const files = ['preset.yml', 'agent.cordis.yml'];
    for (const file of files) {
      const src = join(srcDir, file);
      const dest = join(targetDir, file);
      if (existsSync(src)) {
        copyFileSync(src, dest);
      }
    }
    logger?.info?.(`[yolo-mode] Preset synced to ${targetDir}`);
  } catch (err) {
    logger?.warn?.(`[yolo-mode] Failed to sync preset: ${err.message}`);
  }
}

export const name = 'yolo-mode';

export function apply(ctx) {
  if (ctx[kYoloEnabled]) return;
  ctx[kYoloEnabled] = true;

  syncPresetFiles(ctx.logger);

  // 1. Auto-accept approvals for YOLO mode
  ctx.on('approval/request', async function(req, next) {
    if (isYoloAgent(ctx, req.agent)) {
      ctx.logger?.info?.(`[yolo-mode] Auto-accepting approval request: ${req.toolName}`);
      return 'allowed-once';
    }
    return next();
  }, true);

  // Ensure approval service doesn't drop requests to 'never' for YOLO sessions
  ctx.inject(['approval'], (scope) => {
    const approval = scope.approval;
    if (approval && typeof approval.effectivePolicy === 'function') {
      const origEffective = approval.effectivePolicy.bind(approval);
      approval.effectivePolicy = function(session) {
        if (session && explicitYoloSessions.has(session.id)) return 'ask';
        try {
          const presets = ctx.get('agentPresets');
          if (presets) {
            const agent = ctx.get('agents')?.get(session.id);
            if (agent && presets.composedPreset(agent.ctx) === 'yolo') return 'ask';
          }
        } catch {}
        return origEffective(session);
      };
    }
  });

  // 2. Auto-accept user questions & plan reviews
  ctx.on('user-questions/request', async function(req, next) {
    if (isYoloAgent(ctx, req.agent)) {
      ctx.logger?.info?.(`[yolo-mode] Auto-answering questions (${req.questions.length})`);
      const answers = req.questions.map((q) => {
        if (q.intent?.kind === 'plan-review') {
          return { id: q.id, selected: [q.intent.approve] };
        }
        if (q.options && q.options.length > 0) {
          const rec = q.options.find(opt => opt.label.includes('(Recommended)'));
          return { id: q.id, selected: [rec ? rec.label : q.options[0].label] };
        }
        return { id: q.id, selected: [], custom: 'yes' };
      });
      return { answers };
    }
    return next();
  }, true);

  // 3. Track failures and auto-continue
  const trackedAgents = new Set();
  ctx.on('agent/created', ({ agent }) => {
    trackedAgents.add(agent);
  });
  ctx.on('agent/disposed', ({ agent }) => {
    trackedAgents.delete(agent);
  });

  ctx.on('agent/error', ({ agent, error }) => {
    if (isYoloAgent(ctx, agent)) {
      const state = getAgentState(agent);
      state.shouldContinue = true;
      state.lastFailureReason = error instanceof Error ? error.message : String(error);
    }
  });

  ctx.on('session/event', (session, event) => {
    let agent = null;
    for (const a of trackedAgents) {
      if (a.session?.id === session.id) {
        agent = a;
        break;
      }
    }
    if (!agent) {
      try {
        agent = ctx.get('agents')?.get(session.id);
      } catch {}
    }
    if (!agent || !isYoloAgent(ctx, agent)) return;

    const state = getAgentState(agent);

    if (event.type === 'turn/start') {
      state.lastToolFailed = false;
    } else if (event.type === 'turn/end') {
      const reason = event.data?.reason;
      if (reason?.kind === 'aborted') {
        state.shouldContinue = false;
        state.lastToolFailed = false;
        state.continueCount = 0;
      } else if (reason?.kind === 'error') {
        state.shouldContinue = true;
        state.lastFailureReason = reason.error?.message || 'turn error';
      } else if (reason?.kind === 'completed') {
        if (state.lastToolFailed) {
          state.shouldContinue = true;
        }
      }
    } else if (event.type === 'tool/result') {
      const failed = checkToolFailure(event.data);
      state.lastToolFailed = failed;
      if (failed) {
        state.lastFailureReason = `tool execution failure (${event.data?.toolName || 'tool'})`;
      }
    }
  });

  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle' || !isYoloAgent(ctx, agent)) return;
    const state = getAgentState(agent);

    if (state.shouldContinue) {
      if (state.continueCount >= MAX_CONSECUTIVE_CONTINUES) {
        ctx.logger?.warn?.(`[yolo-mode] Agent ${agent.id} reached max consecutive continues (${MAX_CONSECUTIVE_CONTINUES}). Stopping.`);
        state.shouldContinue = false;
        state.lastToolFailed = false;
        state.continueCount = 0;
        return;
      }

      state.shouldContinue = false;
      state.lastToolFailed = false;
      state.continueCount += 1;

      const attempt = state.continueCount;
      const reason = state.lastFailureReason || 'failure';
      ctx.logger?.info?.(`[yolo-mode] Auto-continuing agent ${agent.id} (attempt ${attempt}/${MAX_CONSECUTIVE_CONTINUES}) due to: ${reason}`);

      setTimeout(() => {
        try {
          if (agent.status === 'idle') {
            const msg = makeContinueMessage();
            agent.followup(msg);
          }
        } catch (err) {
          ctx.logger?.error?.(`[yolo-mode] Failed to followup continue: ${err.message}`);
        }
      }, 100);
    } else {
      state.continueCount = 0;
      state.lastToolFailed = false;
    }
  });

  // 4. Optional slash command: /yolo
  ctx.inject(['commands'], (scope) => {
    try {
      scope.commands.register({
        name: 'yolo',
        description: 'Toggle YOLO mode for the current session (auto-accept, auto-continue)',
        handler: async (invocation) => {
          const session = invocation.agent?.session;
          if (!session) return { kind: 'error', text: 'No active session.' };

          if (explicitYoloSessions.has(session.id)) {
            explicitYoloSessions.delete(session.id);
            return { kind: 'success', text: 'YOLO mode DISABLED for this session.' };
          } else {
            explicitYoloSessions.add(session.id);
            return { kind: 'success', text: 'YOLO mode ENABLED for this session: auto-accepting actions and auto-continuing on failure.' };
          }
        },
      });
    } catch {}
  });
}
