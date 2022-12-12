import fs from 'fs';
import nodeUtil from 'util';
import os from 'os';
import path from 'path';
import extend from 'extend';

import { Base } from '#self/lib/sdk_base';
import loggers from '#self/lib/logger';
import { pairsToMap } from '#self/lib/rpc/key_value_pair';
import * as utils from '#self/lib/util';
import { ErrorCode } from '../worker_launcher_error_code';
import { ControlPlane } from '../control_plane';
import { Config } from '#self/config';
import { ProcessFunctionProfile, RawFunctionProfile } from '#self/lib/json/function_profile';
import SPEC_TEMPLATE from '../../lib/json/spec.template.json';
import { TurfStartOptions } from '#self/lib/turf/types';
import { kCpuPeriod, kMegaBytes } from '../constants';

export interface BaseOptions {
  inspect?: boolean;
}

export interface StartOptions extends BaseOptions {
  additionalSpec?: any;
  seed?: string;
  mkdirs?: string[],
}

export abstract class BaseStarter extends Base {
  static bundlePathLock = new Map<string, Promise<void>>();

  /**
   * Get worker's full log path.
   * @param {string} baseDir The log base directory.
   * @param {string} workerName The worker's name.
   * @param {string} filename The log filename.
   * @return {string} The full log path.
   */
  static logPath(baseDir: string, workerName: string, ...args: string[]) {
    return path.join(baseDir, 'workers', workerName, ...args);
  }

  /**
   * Find the real bin path
   * @param {string} runtimeName The runtime name.
   * @param {string} binName the binary name.
   * @return {string} The real bin path.
   */
  static findRealBinPath(runtimeName: string, binName: string) {
    const turfWorkDir = process.env.TURF_WORKDIR || path.join(os.homedir(), '.turf');
    const runtimeDir = path.join(turfWorkDir, 'runtime', runtimeName);

    let ret = path.join(runtimeDir, 'bin', binName);
    if (fs.existsSync(ret)) return ret;

    ret = path.join(runtimeDir, 'usr', 'bin', binName);
    if (fs.existsSync(ret)) return ret;

    ret = path.join(runtimeDir, binName);
    if (fs.existsSync(ret)) return ret;

    throw new Error(`No executable ${binName} in turf runtime ${runtimeName}.`);
  }

  /**
   * Parse --v8-options string to array
   * @param {string} str The --v8-options string.
   * @return {string[]} The parsed --v8-options.
   */
  static parseV8OptionsString(str: string) {
    const lines = str.replace(/^([\w\W]+Options:)/, '').trim().split('\n')
      .map(line => line.trim());

    const ret = [];
    let name: string;
    for (let i = 0; i < lines.length; i++) {
      if (i % 2 === 0) {
        name = lines[i].replace(/(\s+(\(.+\))?)$/, '');
      } else {
        ret.push(name!);

        const meta = /^type: (.+?)(\s+.*)?$/.exec(lines[i]);
        if (meta?.[1] === 'bool') {
          ret.push(name!.replace('--', '--no-'));
        }
      }
    }

    return ret;
  }

  runtime;
  bin;
  logger;
  plane;
  config;
  turf;
  _validV8Options: string[];

  /**
   * constructor
   * @param {string} runtime The runtime name.
   * @param {string} bin The bin name.
   * @param {string} loggerName The logger name.
   * @param {import('../control_plane').ControlPlane} plane The plane object.
   * @param {typeof import('#self/config/default')} config The global config object.
   */
  constructor(runtime: string, bin: string, loggerName: string, plane: ControlPlane, config: Config) {
    super();
    this.runtime = runtime;
    this.bin = bin;
    this.logger = loggers.get(loggerName);
    this.plane = plane;
    this.config = config;
    this._validV8Options = [];
    this.turf = plane.turf;
  }

  /**
   * @type {string[]}
   */
  get validV8Options() {
    return this._validV8Options;
  }

  /**
   * Init valid v8 options (override)
   */
  abstract _initValidV8Options(): void;

  /**
   * Init (override)
   */
  async _init() {
    this._initValidV8Options();
  }

  /**
   * Close (override)
   */
  abstract _close(): Promise<void>;

  /**
   * Get common exec argv
   * @param {import('#self/lib/json/function_profile').RawFunctionProfile} profile The function profile.
   * @param {{ inspect?: boolean }} options The options.
   * @return {string[]} The common exec argv.
   */
  getCommonExecArgv(profile: RawFunctionProfile, options: BaseOptions = {}) {
    const ret = [];

    if (profile.resourceLimit?.memory !== undefined) {
      // 为堆外预留 20% 的空间
      ret.push(`--max-heap-size=${Math.floor((profile.resourceLimit.memory / kMegaBytes) * 0.8)}`);
    }

    if (options.inspect) {
      ret.push(this.runtime === 'nodejs' ? '--inspect=127.0.0.1:0' : '--inspect');
    }

    return ret;
  }

  /**
   * Check v8 options
   * @param {string[]} options The v8 options.
   */
  checkV8Options(options: string[]) {
    for (let opt of options) {
      opt = opt.replace(/(=.*)?$/, '');
      if (!this.validV8Options.includes(opt)) {
        const err = new Error(`Additional v8Options array includes an invalid v8 option ${opt}.`);
        err.code = ErrorCode.kInvalidV8Option;
        throw err;
      }
    }
  }

  /**
   * Get exec argv
   * @param {import('#self/lib/json/function_profile').RawFunctionProfile} profile The function profile.
   * return {string[]} The additional exec argv.
   */
  getExecArgvFromProfiler(profile: RawFunctionProfile) {
    return ([] as string[]).concat(profile?.worker?.v8Options ?? [], profile?.worker?.execArgv ?? []);
  }

  /**
   * do turf start
   * @param {string} name the container name
   * @param {string} bundlePath the bundle path (which has `code` under it)
   * @param {string[]} args the run command
   * @param {import('#self/lib/json/function_profile').RawFunctionProfile} profile the profile to be started
   * @param {object} [appendEnvs] the environment variables to be appended
   * @param {{ additionalSpec?: object, seed?: string, inspect?: boolean }} options the start options
   * @return {Promise<void>} a promise
   */
  async doStart(name: string, bundlePath: string, args: string[], profile: ProcessFunctionProfile, appendEnvs: Record<string, string> = {}, options: StartOptions = {}) {
    const codePath = path.join(bundlePath, 'code');

    const envs = Object.assign(
      {
        TZ: process.env.TZ,
      },
      this.plane.platformEnvironmentVariables,
      pairsToMap(profile.environments || []),
      appendEnvs);

    envs.NOSLATE_WORKER_ID = name;
    envs.HOME = codePath;

    delete envs.PATH;
    delete envs.TERM;

    const specPath = path.join(bundlePath, 'config.json');
    const spec = extend(true, {}, SPEC_TEMPLATE, options?.additionalSpec || {});

    spec.process.args = args;
    spec.process.env = spec.process.env.concat(Object.keys(envs).map(key => `${key}=${envs[key]}`));
    spec.turf.runtime = profile.runtime;

    if (profile.resourceLimit?.memory !== undefined) {
      spec.linux.resources.memory.limit = profile.resourceLimit.memory;
    }
    if (profile.resourceLimit?.cpu !== undefined && profile.resourceLimit.cpu > 0 && profile.resourceLimit.cpu <= 1) {
      // "cpu": {
      //   "shares": 1024,
      //   "quota": 1000000,
      //   "period": 1000000
      // }
      // Expected cpu time share with turf (ms/1s): quota / period / 1000.
      spec.linux.resources.cpu = {
        shares: 1024,
        quota: profile.resourceLimit.cpu * kCpuPeriod,
        period: kCpuPeriod,
      };
    }

    // inspect 模式下最大可用扩大 100 倍
    // 但在扩缩容统计中只占原始内存池
    if (options?.inspect) {
      spec.linux.resources.memory.limit *= 100;
    }

    const runLogDir = this.config.logger.dir;
    const logPath = BaseStarter.logPath(runLogDir, name);

    this.logger.info('create directories for worker(%s)', name);
    await Promise.all([logPath, ...(options?.mkdirs ?? [])].map(dir =>
        fs.promises.mkdir(dir, { recursive: true })
      )
    );

    await this._bundlePathLock(bundlePath, async () => {
      await fs.promises.writeFile(specPath, JSON.stringify(spec), 'utf8');
      this.logger.info('turf create (%s, %s)', name, bundlePath);
      await this.turf.create(name, bundlePath);
    });

    const startOptions: TurfStartOptions = {
      stdout: path.join(logPath, 'stdout.log'),
      stderr: path.join(logPath, 'stderr.log'),
    };
    if (options?.seed) startOptions.seed = options.seed;
    this.logger.info('turf start (%s)', name);
    await this.turf.start(name, startOptions);
  }

  private async _bundlePathLock<T>(bundlePath: string, fn: () => T) {
    const start = Date.now();
    let bundlePathLock = BaseStarter.bundlePathLock.get(bundlePath);
    while (bundlePathLock != null) {
      await bundlePathLock;
      bundlePathLock = BaseStarter.bundlePathLock.get(bundlePath);
    }

    this.logger.info('fetched lock on bundle path(%s) cost %d ms', bundlePath, Date.now() - start);
    const { promise, resolve } = utils.createDeferred<void>();
    BaseStarter.bundlePathLock.set(bundlePath, promise);
    try {
      return await fn();
    } finally {
      BaseStarter.bundlePathLock.delete(bundlePath);
      resolve();
    }
  }

  /**
   * Start a worker process.
   * @param {string} serverSockPath The server socket path.
   * @param {string} name The worker name.
   * @param {string} credential The worker credential.
   * @param {import('#self/lib/json/function_profile').RawFunctionProfile} profile The function profile object.
   * @param {string} bundlePath The bundle path.
   * @param {{ inspect?: boolean }} options The options.
   */
   abstract start(serverSockPath: string, name: string, credential: string, profile: RawFunctionProfile, bundlePath: string, options: BaseOptions): Promise<void>;
}
