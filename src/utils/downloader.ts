import { invoke, path } from '@tauri-apps/api';
import { Child, Command } from '@tauri-apps/api/shell';
import { EventEmitter } from './event';
import { Response } from '../interfaces/Response';

const GOPEED_HOST = '127.0.0.1';
const GOPEED_PORT_START = 19999;
const GOPEED_PORT_END = 20020;
const POLL_INTERVAL = 1000;

export enum DownloadStatus {
  Waiting = 'waiting',
  Active = 'active',
  Paused = 'paused',
  Error = 'error',
  Complete = 'complete',
  Removed = 'removed',
}

export type DownloadResult = any;
export interface DownloadEngineTask {
  gid: DownloadGid;
  status: DownloadStatus;
  completedLength: number;
  totalLength: number;
  files: { path: string }[];
  errorMessage: string;
  dir: string;
  [key: string]: any;
}

export type DownloadGid = string;

interface GopeedResult<T> {
  code: number;
  msg: string;
  data: T;
}

interface GopeedTask {
  id: string;
  status: 'ready' | 'running' | 'pause' | 'wait' | 'error' | 'done';
  progress?: {
    downloaded?: number;
    speed?: number;
  };
  meta?: {
    req?: {
      url?: string;
    };
    res?: {
      size?: number;
      files?: { name?: string; path?: string; size?: number }[];
    };
    opts?: {
      name?: string;
      path?: string;
    };
  };
  name?: string;
}

class DownloadEngine {
  #ready = false;
  #port = GOPEED_PORT_START;
  #child?: Child;
  #log?: ICategoriedLogger;
  #pollTimer?: number;
  #watchedGids = new Set<string>();
  #statusMap = new Map<string, DownloadStatus>();
  #proxy = {
    enableProxy: false,
    proxyUrl: '',
  };

  get ready() {
    return this.#ready;
  }

  onReady = new EventEmitter();
  onDownloadStart = new EventEmitter<string>();
  onDownloadPause = new EventEmitter<string>();
  onDownloadStop = new EventEmitter<string>();
  onDownloadComplete = new EventEmitter<string>();
  onDownloadError = new EventEmitter<string>();

  async bootstrap() {
    if (this.#ready) throw new Error('Download engine is already ready');

    this.#log = log.category('GOPEED');
    await this.#spawn();
    window.addEventListener(
      'beforeunload',
      () => {
        if (this.#pollTimer) {
          clearTimeout(this.#pollTimer);
        }
        this.#child?.kill();
      },
      { once: true },
    );
    this.#ready = true;
    this.#startPolling();
    this.onReady.emit();
  }

  async #spawn() {
    const dataDir = await path.join(await path.appDataDir(), 'gopeed');
    let lastErr: any;

    for (let port = GOPEED_PORT_START; port <= GOPEED_PORT_END; port++) {
      const command = Command.sidecar('binaries/gopeed-web', [
        '-A',
        GOPEED_HOST,
        '-P',
        port.toString(),
        '-d',
        dataDir,
      ]);

      command.stdout.on('data', (line) => this.#log?.info(line));
      command.stderr.on('data', (line) => this.#log?.warn(line));

      const child = await command.spawn();
      this.#child = child;
      this.#port = port;

      try {
        await this.#waitForReady();
        this.#log?.info(`Gopeed is listening on ${this.#baseUrl}`);
        return;
      } catch (err) {
        lastErr = err;
        await child.kill();
      }
    }

    throw lastErr || new Error('Failed to start Gopeed');
  }

  get #baseUrl() {
    return `http://${GOPEED_HOST}:${this.#port}`;
  }

  async #waitForReady() {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 8000) {
      try {
        await this.#request('GET', '/api/v1/info');
        return;
      } catch (err) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error('Gopeed API did not become ready');
  }

  async #request<T = any>(
    method: string,
    apiPath: string,
    body?: any,
  ): Promise<T> {
    const res = await invoke<Response>('network_fetch', {
      method,
      url: `${this.#baseUrl}${apiPath}`,
      body: body ? JSON.stringify(body) : '',
      enableProxy: false,
      proxyUrl: '',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      responseType: 'json',
    });

    const result = res.body as GopeedResult<T>;
    if (result.code !== 0) {
      throw new Error(result.msg || `Gopeed API failed: ${apiPath}`);
    }

    return result.data;
  }

  #startPolling() {
    const poll = async () => {
      try {
        if (this.#watchedGids.size > 0) {
          const gids = Array.from(this.#watchedGids);
          const tasks = await this.#getTasksByIds(gids);

          for (const gid of gids) {
            const task = tasks[gid];
            if (!task) continue;
            this.#emitStatusIfChanged(gid, this.#mapStatus(task.status));
          }
        }
      } catch (err) {
        this.#log?.warn('Poll failed', err);
      } finally {
        this.#pollTimer = window.setTimeout(poll, POLL_INTERVAL);
      }
    };

    poll();
  }

  #watch(gid: string, status?: DownloadStatus) {
    this.#watchedGids.add(gid);
    if (status) this.#statusMap.set(gid, status);
  }

  #emitStatusIfChanged(gid: string, status: DownloadStatus) {
    const oldStatus = this.#statusMap.get(gid);
    if (oldStatus === status) return;

    this.#statusMap.set(gid, status);
    switch (status) {
      case DownloadStatus.Active:
        this.onDownloadStart.emit(gid);
        break;
      case DownloadStatus.Paused:
        this.onDownloadPause.emit(gid);
        break;
      case DownloadStatus.Error:
        this.onDownloadError.emit(gid);
        break;
      case DownloadStatus.Complete:
        this.onDownloadComplete.emit(gid);
        this.#watchedGids.delete(gid);
        break;
      case DownloadStatus.Removed:
        this.onDownloadStop.emit(gid);
        this.#watchedGids.delete(gid);
        break;
      default:
        break;
    }
  }

  ensureReady() {
    if (!this.ready) throw new Error('Download engine is not ready yet');
  }

  async updateProxy(enableProxy: boolean, proxyUrl: string) {
    this.#proxy = { enableProxy, proxyUrl };
    if (!this.ready) return;

    const cfg = await this.#request<any>('GET', '/api/v1/config');
    cfg.proxy = this.#buildGopeedProxy(enableProxy, proxyUrl);
    await this.#request('PUT', '/api/v1/config', cfg);
  }

  #buildGopeedProxy(enableProxy: boolean, proxyUrl: string) {
    if (!enableProxy) {
      return {
        enable: false,
        system: false,
        scheme: '',
        host: '',
        usr: '',
        pwd: '',
      };
    }

    if (!proxyUrl) {
      return {
        enable: true,
        system: true,
        scheme: '',
        host: '',
        usr: '',
        pwd: '',
      };
    }

    const url = new URL(proxyUrl);
    return {
      enable: true,
      system: false,
      scheme: url.protocol.replace(':', ''),
      host: url.host,
      usr: decodeURIComponent(url.username),
      pwd: decodeURIComponent(url.password),
    };
  }

  async addUri(
    url: string,
    options: { dir: string; out: string },
  ): Promise<string> {
    this.ensureReady();
    await this.updateProxy(this.#proxy.enableProxy, this.#proxy.proxyUrl);
    const gid = await this.#request<string>('POST', '/api/v1/tasks', {
      req: {
        url,
      },
      opts: {
        name: options.out,
        path: options.dir,
      },
    });
    this.#watch(gid, DownloadStatus.Waiting);
    return gid;
  }

  async batchAddUri(
    tasks: { url: string; options: { dir: string; out: string } }[],
  ): Promise<string[]> {
    this.ensureReady();
    await this.updateProxy(this.#proxy.enableProxy, this.#proxy.proxyUrl);
    const gids = await this.#request<string[]>('POST', '/api/v1/tasks/batch', {
      reqs: tasks.map((task) => ({
        req: {
          url: task.url,
        },
        opts: {
          name: task.options.out,
          path: task.options.dir,
        },
      })),
    });
    gids.forEach((gid) => this.#watch(gid, DownloadStatus.Waiting));
    return gids;
  }

  async tellStatus(gid: DownloadGid): Promise<DownloadEngineTask>;
  async tellStatus(
    gid: DownloadGid[],
  ): Promise<Record<DownloadGid, DownloadEngineTask>>;
  async tellStatus(gid: DownloadGid | DownloadGid[]) {
    this.ensureReady();
    if (!Array.isArray(gid)) {
      const task = await this.#request<GopeedTask>(
        'GET',
        `/api/v1/tasks/${gid}`,
      );
      return this.#toDownloadEngineTask(task);
    }

    return this.#getTasksByIds(gid).then(async (tasks) => {
      const result: Record<DownloadGid, DownloadEngineTask> = {};
      for (const [id, task] of Object.entries(tasks)) {
        result[id] = await this.#toDownloadEngineTask(task);
      }
      return result;
    });
  }

  async #getTasksByIds(gids: string[]) {
    const allTasks = await this.#request<GopeedTask[]>('GET', '/api/v1/tasks');
    const wanted = new Set(gids);
    return Object.fromEntries(
      allTasks
        .filter((task) => wanted.has(task.id))
        .map((task) => [task.id, task]),
    );
  }

  async #toDownloadEngineTask(task: GopeedTask): Promise<DownloadEngineTask> {
    const dir = task.meta?.opts?.path || '';
    const fileName = task.name || task.meta?.opts?.name || '';
    const filePath =
      dir && fileName ? await path.join(dir, fileName) : fileName;
    const totalLength = task.meta?.res?.size || task.progress?.downloaded || 0;

    return {
      gid: task.id,
      status: this.#mapStatus(task.status),
      completedLength: task.progress?.downloaded || 0,
      totalLength,
      files: [{ path: filePath }],
      errorMessage: task.status === 'error' ? 'Gopeed download failed' : '',
      dir,
    };
  }

  #mapStatus(status: GopeedTask['status']) {
    switch (status) {
      case 'running':
        return DownloadStatus.Active;
      case 'pause':
        return DownloadStatus.Paused;
      case 'error':
        return DownloadStatus.Error;
      case 'done':
        return DownloadStatus.Complete;
      case 'ready':
      case 'wait':
      default:
        return DownloadStatus.Waiting;
    }
  }

  async pause(gid: string) {
    this.ensureReady();
    await this.#request('PUT', `/api/v1/tasks/${gid}/pause`);
    this.#emitStatusIfChanged(gid, DownloadStatus.Paused);
  }

  async pauseAll() {
    this.ensureReady();
    await this.#request('PUT', '/api/v1/tasks/pause');
  }

  async unpause(gid: string) {
    this.ensureReady();
    await this.#request('PUT', `/api/v1/tasks/${gid}/continue`);
    this.#watch(gid);
  }

  async unpauseAll() {
    this.ensureReady();
    await this.#request('PUT', '/api/v1/tasks/continue');
  }

  async remove(gid: string) {
    this.ensureReady();
    await this.#request('DELETE', `/api/v1/tasks/${gid}`);
    this.#emitStatusIfChanged(gid, DownloadStatus.Removed);
  }

  async batchRemove(gids: string[]) {
    await Promise.all(gids.map((gid) => this.remove(gid)));
  }
}

export const downloadEngine = new DownloadEngine();
