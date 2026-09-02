import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';

export function parseEventLine(line) {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return { type: 'raw', text: line };
  }
}

function textFromItem(item) {
  if (!item || typeof item !== 'object') return '';
  if (typeof item.text === 'string') return item.text;
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) {
    return item.content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('');
  }
  return '';
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens;
  const outputTokens = usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens;
  const totalTokens = usage.totalTokens ?? usage.total_tokens ?? (
    Number.isFinite(inputTokens) && Number.isFinite(outputTokens) ? inputTokens + outputTokens : undefined
  );
  if (![inputTokens, outputTokens, totalTokens].some((value) => Number.isFinite(value))) return null;
  return { inputTokens, outputTokens, totalTokens };
}

function threadSettings(thread) {
  return {
    model: thread?.model || thread?.modelSlug || null,
    effort: thread?.reasoningEffort || thread?.reasoning_effort || null,
  };
}

export async function getConfiguredModel(env = process.env) {
  const settings = await getConfiguredSettings(env);
  return settings.model;
}

export async function getConfiguredSettings(env = process.env) {
  const codexHome = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  try {
    const config = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    const model = config.match(/^model\s*=\s*["']([^"']+)["']\s*$/m)?.[1];
    const effort = config.match(/^model_reasoning_effort\s*=\s*["']([^"']+)["']\s*$/m)?.[1];
    return { model: model || 'default', effort: effort || 'default' };
  } catch {
    return { model: 'default', effort: 'default' };
  }
}

export function normalizeAppServerMessage(message) {
  if (!message || typeof message !== 'object' || typeof message.method !== 'string') return null;
  const params = message.params || {};

  if (message.method === 'thread/started' && params.thread?.id) {
    const settings = threadSettings(params.thread);
    return { type: 'session', id: params.thread.id, ...settings };
  }
  if (message.method === 'turn/started') {
    return { type: 'status', status: 'thinking', turnId: params.turn?.id || null };
  }
  if (message.method === 'item/agentMessage/delta') {
    return { type: 'text', text: params.delta || '', itemId: params.itemId || null };
  }
  if (message.method === 'item/completed' && params.item?.type === 'agentMessage') {
    return { type: 'text-complete', text: textFromItem(params.item), itemId: params.item.id || null };
  }
  if (message.method === 'thread/tokenUsage/updated') {
    return { type: 'usage', usage: normalizeUsage(params.tokenUsage?.last || params.tokenUsage) };
  }
  if (message.method === 'turn/completed') {
    return { type: 'status', status: params.turn?.status === 'failed' ? 'failed' : 'complete' };
  }
  if (message.method === 'error') {
    return { type: 'error', message: params.message || params.error?.message || 'Codex returned an error.' };
  }
  return { type: 'event', event: message };
}

export class CodexAppServer {
  constructor({ codexPath = process.env.BIRIBIRI_CODEX || 'codex', spawnImpl = spawn, prefixArgs = [] } = {}) {
    this.codexPath = codexPath;
    this.spawnImpl = spawnImpl;
    this.prefixArgs = prefixArgs;
    this.child = null;
    this.lines = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.ready = false;
    this.startPromise = null;
    this.onNotification = () => {};
  }

  async start() {
    if (this.ready) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const child = this.spawnImpl(this.codexPath, [...this.prefixArgs, 'app-server', '--stdio'], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      this.lines = createInterface({ input: child.stdout });
      this.lines.on('line', (line) => this.handleMessage(parseEventLine(line)));
      child.stderr.on('data', (chunk) => this.onNotification({ method: 'stderr', params: { text: String(chunk) } }));
      child.once('error', (error) => this.failPending(error));
      child.once('close', (code, signal) => {
        this.ready = false;
        this.child = null;
        this.failPending(new Error(`Codex app-server exited with ${signal || `code ${code}`}.`));
      });

      await this.request('initialize', {
        clientInfo: { name: 'biribiri', version: '0.0.1' },
        capabilities: { experimentalApi: true },
      });
      this.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
      this.ready = true;
    })();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  send(message) {
    if (!this.child?.stdin.writable) throw new Error('Codex app-server is not running.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}) {
    if (!this.child) return Promise.reject(new Error('Codex app-server is not running.'));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.id !== undefined && message.id !== null) {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message || 'Codex app-server request failed.'));
      else request.resolve(message.result);
      return;
    }
    if (message.method) this.onNotification(message);
  }

  failPending(error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  async startThread({ cwd }) {
    await this.start();
    return this.request('thread/start', { cwd, model: null });
  }

  async resumeThread({ threadId, cwd }) {
    await this.start();
    return this.request('thread/resume', { threadId, cwd: cwd || null, excludeTurns: false });
  }

  async startTurn({ threadId, prompt, cwd, onNotification }) {
    await this.start();
    const previous = this.onNotification;
    return new Promise((resolve, reject) => {
      let startResult;
      let finished = false;
      const cleanup = () => {
        if (this.onNotification === handler) this.onNotification = previous;
      };
      const finish = (callback, value) => {
        if (finished) return;
        finished = true;
        cleanup();
        callback(value);
      };
      const handler = (message) => {
        onNotification(message);
        if (message?.method === 'turn/completed' && message.params?.threadId === threadId) {
          finish(resolve, { ...startResult, turn: message.params.turn });
        }
      };
      this.onNotification = handler;
      this.request('turn/start', {
        threadId,
        cwd,
        input: [{ type: 'text', text: prompt }],
      }).then((result) => {
        startResult = result;
      }).catch((error) => finish(reject, error));
    });
  }

  async interruptTurn({ threadId, turnId }) {
    if (!threadId || !turnId) return false;
    await this.request('turn/interrupt', { threadId, turnId });
    return true;
  }

  async close() {
    this.lines?.close();
    this.failPending(new Error('Codex app-server closed.'));
    if (this.child) this.child.kill('SIGTERM');
    this.child = null;
    this.ready = false;
  }
}

export class CodexRunner {
  constructor(options = {}) {
    this.appServer = options.appServer || new CodexAppServer(options);
    this.model = options.model || null;
    this.effort = options.effort || null;
    this.threadId = null;
    this.turnId = null;
  }

  async run({ sessionId, prompt, cwd = process.cwd(), onEvent = () => {} }) {
    let thread;
    if (sessionId) {
      const result = await this.appServer.resumeThread({ threadId: sessionId, cwd });
      thread = result?.thread;
    } else {
      const result = await this.appServer.startThread({ cwd });
      thread = result?.thread;
      this.model = result?.model || this.model;
      this.effort = result?.reasoningEffort || this.effort;
    }
    this.threadId = thread?.id || sessionId;
    if (!this.threadId) throw new Error('Codex did not return a thread id.');
    const settings = threadSettings(thread);
    this.model = settings.model || this.model;
    this.effort = settings.effort || this.effort;
    onEvent({ type: 'session', id: this.threadId, model: this.model, effort: this.effort });

    let text = '';
    const streamedItemIds = new Set();
    const result = await this.appServer.startTurn({
      threadId: this.threadId,
      prompt,
      cwd,
      onNotification: (message) => {
        const event = normalizeAppServerMessage(message);
        if (!event) return;
        if (event.type === 'status' && event.turnId) this.turnId = event.turnId;
        if (event.type === 'text' && event.itemId) streamedItemIds.add(event.itemId);
        if (event.type === 'text-complete' && event.itemId && streamedItemIds.has(event.itemId)) return;
        if (event.type === 'text' || event.type === 'text-complete') text += event.text;
        onEvent(event, message);
      },
    });
    this.turnId = null;
    return { sessionId: this.threadId, text, result };
  }

  interrupt() {
    if (!this.threadId || !this.turnId) return false;
    void this.appServer.interruptTurn({ threadId: this.threadId, turnId: this.turnId }).catch(() => {});
    return true;
  }

  async close() {
    await this.appServer.close();
  }
}
