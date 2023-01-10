import { config } from '#self/config';
import cp from 'child_process';

import Logger from '../logger';
import { createDeferred, isNotNullish, sleep } from '../util';
import { TurfSession } from './session';
import { TurfStartOptions, TurfException, TurfProcess, TurfState, TurfCode } from './types';

const logger = Logger.get('turf/wrapper');

const TurfPsLineMatcher = /(\S+)\s+(\d+)\s+(\S+)/;
const TurfStateLineMatcher = /(\S+):\s+(\S+)/;

export { TurfContainerStates } from './types';

const TurfStopIgnorableCodes = [
  TurfCode.ECHILD,
  TurfCode.ENOENT,
];
const TurfStopRetryableCodes = [
  TurfCode.EAGAIN,
];

export class Turf {
  session: TurfSession;
  constructor(public turfPath: string, public sockPath: string) {
    this.session = new TurfSession(sockPath);
    this.session.on('error', (err) => this._onSessionError(err));
  }

  private _onSessionError(err: unknown) {
    logger.error('unexpected error on turf session:', err);
    this.session = new TurfSession(this.sockPath);
    this.session.on('error', (err) => this._onSessionError(err));
    this.session.connect()
      .then(() => {
        logger.info('turf session re-connected');
      }, () => { /** identical to error event */ });
  }

  async connect() {
    await this.session.connect();
    logger.info('turf session connected');
  }

  async close() {
    await this.session.close();
  }

  #exec(args: string[], cwd?: string) {
    const cmd = this.turfPath;

    const deferred = createDeferred<string>();

    const opt: cp.SpawnOptions = { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] };
    if (cwd) {
      opt.cwd = cwd;
    }

    const command = [ cmd ].concat(args).join(' ');
    const start = process.hrtime.bigint();
    const child = cp.spawn(cmd, args, opt);
    const result = {
      stdout: [] as Buffer[],
      stderr: [] as Buffer[],
    };
    child.stdout!.on('data', chunk => {
      result.stdout.push(chunk);
    });
    child.stderr!.on('data', chunk => {
      result.stderr.push(chunk);
    });
    // Listen on 'close' event instead of 'exit' event to wait stdout and stderr to be closed.
    child.on('close', (code, signal) => {
      logger.debug(`ran ${command}, cwd: ${opt.cwd || process.cwd()}, consume %s ns`, process.hrtime.bigint() - start);
      const stdout = Buffer.concat(result.stdout).toString('utf8');
      if (code !== 0) {
        const stderr = Buffer.concat(result.stderr).toString('utf8')
        const err = new Error(`Turf exited with non-zero code(${code}, ${signal}): ${stderr}`) as TurfException;
        err.code = code;
        err.signal = signal;
        err.stderr = stderr;
        err.stdout = stdout;
        return deferred.reject(err);
      }
      deferred.resolve(stdout);
    });

    return deferred.promise;
  }

  async #send(args: string[]) {
    const start = process.hrtime.bigint();
    const command = args.join(' ');
    const ret = await this.session.send(args)
      .finally(() => {
        logger.debug(`send %s, consume %s ns`, command, process.hrtime.bigint() - start);
      });
    if (ret.header.code !== 0) {
      const err = new Error(`Turf response with non-zero code(${ret.header.code})`);
      err.code = ret.header.code;
      throw err;
    }
  }

  #sendOrExec(args: string[]) {
    if (config.turf.socketSession) {
      return this.#send(args);
    } else {
      return this.#exec(args);
    }
  }

  async create(containerName: string, bundlePath: string) {
    return await this.#sendOrExec([ 'create', '-b', bundlePath, containerName ]);
  }

  async start(containerName: string, options: TurfStartOptions = {}) {
    const args = [ 'start' ];

    const ADDITIONAL_KEYS = [ 'seed', 'stdout', 'stderr' ] as const;
    for (const key of ADDITIONAL_KEYS) {
      const val = options[key];
      if (val) {
        args.push(`--${key}`);
        args.push(val);
      }
    }

    args.push(containerName);

    return this.#sendOrExec(args);
  }

  async #stop(containerName: string, force: boolean) {
    const args = ['stop'];
    if (force) {
      args.push('--force');
    }
    args.push(containerName);
    try {
      await this.#send(args);
    } catch (e: any) {
      if (TurfStopIgnorableCodes.includes(e.code)) {
        return;
      }
      throw e;
    }
  }

  async stop(containerName: string) {
    try {
      await this.#stop(containerName, false);
    } catch (e: any) {
      if (!TurfStopRetryableCodes.includes(e.code)) {
        logger.info(`%s stop failed`, containerName, e.message);
        throw e;
      }
      // TODO(chengzhong.wcz): yield retrying to callers.
      logger.info(`%s stop failed, retrying`, containerName);
      let retry = 3;
      while (retry >= 1) {
        retry--;
        try {
          await sleep(1000);
          await this.#stop(containerName, true);
        } catch (e: any) {
          if (retry === 0 || !TurfStopRetryableCodes.includes(e.code)) {
            logger.info(`%s force stop failed, ignore error`, containerName, e.message);
            return;
          }
          logger.info(`%s force stop, retrying`, containerName, retry);
        }
      }
    }
  }

  async delete(containerName: string) {
    return this.#exec([ 'delete', containerName ]);
  }

  async destroy(containerName: string) {
    await this.stop(containerName);
    // TODO: stop 之后可能要等一下才能 delete
    await this.delete(containerName);
  }

  /**
   * ps
   */
  async ps(): Promise<TurfProcess[]> {
    const ret = await this.#exec([ 'ps' ]);
    const lines = ret.split('\n').filter(l => l);
    if (!lines.length) return [];
    const arr = lines.map(line => {
      const match = TurfPsLineMatcher.exec(line);
      if (match == null) {
        return null;
      }
      const [ /** match */, name, pid, status ] = match;
      return {
        status,
        pid: Number.parseInt(pid),
        name,
      } as TurfProcess;
    }).filter(isNotNullish);

    return arr;
  }

  async state(name: string): Promise<TurfState | null> {
    const ret = await this.#exec([ 'state', name ]);
    const lines = ret.split('\n').filter(l => l);
    if (!lines.length) return null;
    const obj = lines.reduce((obj, line) => {
      // Output format and semantics
      const match = TurfStateLineMatcher.exec(line);
      if (match == null) {
        return obj;
      }
      const [ /** match */, name, value ] = match;
      if (name === 'pid' || name.startsWith('stat.') || name.startsWith('rusage.')) {
        obj[name] = Number.parseInt(value);
      } else {
        obj[name] = value;
      }
      return obj;
    }, {} as Record<string, string | number>);

    return obj as unknown as TurfState;
  }
}
