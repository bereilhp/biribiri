import { emitKeypressEvents } from 'node:readline';
import { getConfiguredSettings } from './codex.js';

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const REVERSE = '\x1b[7m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const MAGENTA = '\x1b[35m';
const RED = '\x1b[31m';

function clean(text) {
  return String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function keyIs(key, name, ctrl = false) {
  return key?.name === name && Boolean(key.ctrl) === ctrl;
}

function tokenCount(value) {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export async function runTui({ runner, cwd = process.cwd(), stdin = process.stdin, stdout = process.stdout, force = false } = {}) {
  if ((!stdin.isTTY || !stdout.isTTY) && !force) throw new Error('biribiri requires an interactive terminal.');
  const settings = await getConfiguredSettings();
  const model = runner.model || settings.model;
  const effort = runner.effort || settings.effort;
  const state = {
    sessionId: null,
    messages: [],
    input: '',
    running: false,
    status: '',
    model,
    effort,
    usage: { inputTokens: null, outputTokens: null, totalTokens: null },
    done: false,
  };

  const write = (value) => stdout.write(value);
  const redraw = () => {
    const width = Math.max(40, stdout.columns || 80);
    const height = Math.max(10, stdout.rows || 24);
    const usage = state.usage;
    const metadata = [
      `${CYAN}Model${RESET} ${GREEN}${clean(state.model)}${RESET}`,
      `${CYAN}Effort${RESET} ${YELLOW}${clean(state.effort)}${RESET}`,
      `${CYAN}Tokens${RESET} ${MAGENTA}${tokenCount(usage.totalTokens)}${RESET}`,
    ].join(' · ');
    const lines = [
      metadata,
    ];
    for (const message of state.messages) {
      const label = message.role === 'user' ? `${GREEN}you${RESET}` : message.role === 'error' ? `${RED}error${RESET}` : `${CYAN}codex${RESET}`;
      const text = clean(message.text || '');
      lines.push('', `${label} ${text}`);
    }
    if (state.status) lines.push('', `${DIM}${state.status}${RESET}`);
    const border = '─'.repeat(width);
    const input = clean(state.input);
    const cursor = `${REVERSE} ${RESET}`;
    const composer = input ? `${input}${cursor}` : `${cursor}${DIM}Ask biribiri${RESET}`;
    lines.push('', `${DIM}${border}${RESET}`, `> ${composer}`, `${DIM}${border}${RESET}`);
    lines.push(`${DIM}Enter send · Ctrl-C interrupt/quit · Ctrl-N new · Ctrl-L clear${RESET}`);
    const body = lines.slice(Math.max(0, lines.length - height + 1));
    write('\x1b[2J\x1b[H' + body.join('\n') + '\x1b[K');
  };

  const submit = async () => {
    const prompt = state.input.trim();
    if (!prompt || state.running) return;
    state.input = '';
    state.messages.push({ role: 'user', text: prompt });
    const assistant = { role: 'assistant', text: '' };
    state.messages.push(assistant);
    state.running = true;
    state.status = 'Thinking…';
    redraw();
    try {
      const result = await runner.run({
        sessionId: state.sessionId,
        prompt,
        cwd,
        onEvent: (event) => {
          if (event.type === 'session') state.sessionId = event.id;
          if (event.model) state.model = event.model;
          if (event.effort) state.effort = event.effort;
          if (event.usage) state.usage = event.usage;
          if (event.type === 'text' || event.type === 'text-complete') assistant.text += event.text;
          if (event.type === 'error') assistant.text += `\n${event.message}`;
          redraw();
        },
      });
      state.sessionId = result.sessionId || state.sessionId;
      state.status = '';
    } catch (error) {
      assistant.text += `\n${error.message}`;
      state.status = 'Failed';
    } finally {
      state.running = false;
      redraw();
    }
  };

  const onKeypress = (input, key = {}) => {
    if (keyIs(key, 'c', true)) {
      if (state.running) { runner.interrupt(); state.status = 'Interrupting…'; }
      else state.done = true;
    } else if (keyIs(key, 'n', true) && !state.running) {
      state.sessionId = null; state.messages = []; state.status = '';
    } else if (keyIs(key, 'l', true)) {
      state.messages = [];
    } else if (keyIs(key, 'return')) {
      void submit();
    } else if (keyIs(key, 'backspace')) {
      state.input = state.input.slice(0, -1);
    } else if (!key.ctrl && !key.meta && input && input !== '\u001b') {
      state.input += input;
    }
    redraw();
  };

  emitKeypressEvents(stdin);
  const wasRaw = stdin.isRaw;
  if (stdin.setRawMode) stdin.setRawMode(true);
  stdin.on('keypress', onKeypress);
  write('\x1b[?25l');
  redraw();

  try {
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        if (state.done) { clearInterval(timer); resolve(); }
      }, 25);
    });
  } finally {
    await runner.close?.();
    stdin.off('keypress', onKeypress);
    if (stdin.setRawMode) stdin.setRawMode(Boolean(wasRaw));
    stdin.pause();
    write('\x1b[?25h\x1b[0m\x1b[2J\x1b[H');
  }
}
