/**
 * dsh-cbm-autorefresh
 *
 * 让每个 DeepSeek Harness 会话在自己的工作区里刷新 codebase-memory 的索引。
 *
 * 触发点：
 *   - `session/created`：会话创建时刷新它自己的工作目录；
 *   - `session/event` + `working-directory/change`：会话中途切换目录时刷新新目录。
 *
 * 每次刷新都是一次或多次**短命** CLI 调用（无变更时 1–3 秒），索引的重活由
 * codebase-memory 的共享 daemon 完成，本插件不常驻任何后台进程。
 *
 * @module dsh-cbm-autorefresh
 */
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const name = 'dsh-cbm-autorefresh';

/** 依赖的 DSH 服务：会话存储 + 每个会话的工作目录。 */
export const inject = ['sessions', 'workingDirectory'];

const DEFAULT_BINARY = join(homedir(), '.local', 'bin', 'codebase-memory-mcp');
const DEFAULT_MIN_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 跑一个命令，返回 { code, stdout, stderr }；永不 reject。
 * @param {string} file
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs: number }} options
 */
function runFile(file, args, options) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        resolve({
          code: error?.code ?? (error ? -1 : 0),
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? '') || String(error?.message ?? ''),
        });
      },
    );
  });
}

/**
 * 在一个目录上执行「刷新该目录所属仓库索引」的流程。
 *
 * @param {{
 *   binary: string,
 *   minIntervalMs: number,
 *   timeoutMs: number,
 *   run?: (file: string, args: string[], options: { cwd?: string, timeoutMs: number }) => Promise<{code:number,stdout:string,stderr:string}>,
 *   log?: (line: string) => void,
 *   now?: () => number,
 * }} options
 */
export function createRefresher(options) {
  const {
    binary,
    minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    run = runFile,
    log = () => {},
    now = () => Date.now(),
  } = options;

  /** @type {Map<string, number>} 目录 -> 上次成功/尝试刷新的时间 */
  const lastRunAt = new Map();
  /** @type {Set<string>} 正在刷新的仓库根，单飞 */
  const inFlight = new Set();

  /**
   * @param {string} directory 绝对路径
   * @param {string} reason 触发来源，仅用于日志
   * @returns {Promise<{status: string, project?: string, elapsedMs?: number}>}
   */
  async function refresh(directory, reason = 'manual') {
    if (!directory) return { status: 'skipped-no-directory' };

    const startedAt = now();
    const previous = lastRunAt.get(directory) ?? 0;
    if (startedAt - previous < minIntervalMs) return { status: 'skipped-throttled' };

    const git = await run('git', ['-C', directory, 'rev-parse', '--show-toplevel'], { timeoutMs: 15_000 });
    if (git.code !== 0) {
      log(`skip(${reason}) ${directory}: 不在 git 工作区内`);
      return { status: 'skipped-not-git' };
    }
    const root = git.stdout.trim();
    if (!root) return { status: 'skipped-not-git' };

    if (inFlight.has(root)) return { status: 'skipped-in-flight' };

    lastRunAt.set(directory, now());
    inFlight.add(root);
    try {
      const list = await run(binary, ['cli', '--quiet', 'list_projects', '--format', 'json'], { timeoutMs });
      if (list.code !== 0) {
        log(`error(${reason}) ${root}: 读取 project 列表失败: ${list.stderr.trim().slice(0, 200)}`);
        return { status: 'error-list' };
      }
      const project = findProject(list.stdout, root);
      if (!project) {
        log(`skip(${reason}) ${root}: 该仓库还没有索引，跳过`);
        return { status: 'skipped-not-indexed' };
      }

      const index = await run(binary, ['cli', '--quiet', 'index_repository', '--repo-path', root], { timeoutMs });
      const elapsedMs = now() - startedAt;
      const text = (index.stdout.trim().split('\n').pop() ?? '').slice(0, 160);
      if (index.code !== 0) {
        log(`error(${reason}) ${project}: exit=${index.code} ${text}`);
        return { status: 'error-index', project, elapsedMs };
      }
      log(`done(${reason}) ${project}: ${elapsedMs}ms`);
      return { status: 'refreshed', project, elapsedMs };
    } finally {
      inFlight.delete(root);
    }
  }

  return { refresh };
}

/**
 * 从 `list_projects --format json` 的输出里按 root_path 精确匹配项目名。
 * @param {string} stdout
 * @param {string} root
 * @returns {string | null}
 */
export function findProject(stdout, root) {
  try {
    const parsed = JSON.parse(stdout.trim());
    const projects = Array.isArray(parsed?.projects) ? parsed.projects : [];
    for (const project of projects) {
      if (project?.root_path === root) return project.name ?? null;
    }
  } catch {
    /* 非 JSON 输出（例如错误文本）当作没找到 */
  }
  return null;
}

/**
 * DSH 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ enabled?: boolean, binary?: string, minIntervalMs?: number, timeoutMs?: number }} [config]
 */
export function apply(ctx, config = {}) {
  const binary = config.binary ?? process.env.CBM_BIN ?? DEFAULT_BINARY;
  const logger = ctx.logger ?? console;

  if (config.enabled === false) {
    logger.info?.('[cbm-autorefresh] disabled by config');
    return;
  }
  if (!existsSync(binary)) {
    logger.warn?.(`[cbm-autorefresh] 找不到 codebase-memory-mcp: ${binary}，插件不工作`);
    return;
  }

  const logFile = config.logFile;
  const log = (line) => {
    logger.info?.(`[cbm-autorefresh] ${line}`);
    if (!logFile) return;
    try {
      mkdirSync(dirname(logFile), { recursive: true });
      appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
    } catch {
      /* 日志写失败不影响刷新 */
    }
  };

  const refresher = createRefresher({
    binary,
    minIntervalMs: config.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    log,
  });

  const safeRefresh = (session, reason, directory) => {
    let target = directory;
    if (!target) {
      try {
        target = ctx.workingDirectory.get(session);
      } catch (error) {
        logger.warn?.(`[cbm-autorefresh] 读取会话工作目录失败: ${error?.message ?? error}`);
        return;
      }
    }
    refresher.refresh(target, reason).catch((error) => {
      logger.warn?.(`[cbm-autorefresh] ${reason} 刷新失败: ${error?.message ?? error}`);
    });
  };

  ctx.on('session/created', (session) => safeRefresh(session, 'session-created'));

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'working-directory/change') return;
    safeRefresh(session, 'working-directory-change', event.data?.cwd);
  });

  // 插件热加载时，已有会话补一次（受节流保护）。
  try {
    for (const session of ctx.sessions?.list?.() ?? []) safeRefresh(session, 'plugin-load');
  } catch (error) {
    logger.warn?.(`[cbm-autorefresh] 枚举已有会话失败: ${error?.message ?? error}`);
  }
}
