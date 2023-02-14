import { Config } from '#self/config';
import {
  ContainerStatus,
  ContainerStatusReport,
  ControlPanelEvent,
} from '#self/lib/constants';
import { FunctionProfileManager } from '#self/lib/function_profile';
import { RawFunctionProfile } from '#self/lib/json/function_profile';
import { PrefixedLogger } from '#self/lib/loggers';
import { Worker, WorkerInitData, WorkerStats } from './worker';
import { WorkerLogger } from './worker_logger';

enum WaterLevelAction {
  UNKNOWN = 0,
  NORMAL = 1,
  NEED_EXPAND = 2,
  NEED_SHRINK = 3,
}

interface StartingPoolItem {
  credential: string;
  estimateRequestLeft?: number;
  maxActivateRequests?: number;
}

class Broker {
  static WaterLevelAction = WaterLevelAction;

  redundantTimes: number;

  config: Config;

  profiles: FunctionProfileManager;

  name: string;

  logger: PrefixedLogger;

  isInspector: boolean;

  data: RawFunctionProfile | null;

  workers: Map<string, Worker>;

  startingPool: Map<string, StartingPoolItem>;

  /**
   * Constructor
   * @param profiles The profile manager.
   * @param config The global config object.
   * @param funcName The function name of this broker.
   * @param isInspector Whether it's using inspector or not.
   */
  constructor(
    profiles: FunctionProfileManager,
    config: Config,
    funcName: string,
    isInspector: boolean,
    public disposable: boolean = false
  ) {
    this.config = config;
    this.logger = new PrefixedLogger(
      'worker_stats_snapshot broker',
      Broker.getKey(funcName, isInspector)
    );

    this.name = funcName;
    this.profiles = profiles;
    this.isInspector = !!isInspector;
    this.data = profiles?.get(funcName)?.toJSON(true) || null;

    this.workers = new Map();
    this.startingPool = new Map();

    this.redundantTimes = 0;
  }

  /**
   * The reservation count of this broker.
   * @return {number} The reservation count.
   */
  get reservationCount() {
    if (this.isInspector) {
      return 1;
    }

    if (this.disposable) {
      return 0;
    }

    return this.data?.worker?.reservationCount || 0;
  }

  get initializationTimeout() {
    return (
      this.data?.worker?.initializationTimeout ||
      this.config.worker.defaultInitializerTimeout
    );
  }

  /**
   * Register worker.
   * @param processName The process name (worker name).
   * @param credential The credential.
   */
  register(workerInitData: WorkerInitData): Worker {
    if (!this.data) {
      throw new Error(`No function profile named ${this.name}.`);
    }
    const worker = new Worker(
      workerInitData,
      this.config,
      this.initializationTimeout
    );

    this.workers.set(workerInitData.processName!, worker);

    this.startingPool.set(workerInitData.processName!, {
      credential: workerInitData.credential!,
      estimateRequestLeft: this.data.worker?.maxActivateRequests,
      maxActivateRequests: this.data.worker?.maxActivateRequests,
    });

    return worker;
  }

  /**
   * Unregister worker.
   * @param name The process name (worker name).
   * @param destroy Whether it should be destroyed by turf.
   */
  async unregister(name: string) {
    const worker = this.workers.get(name);
    this.workers.delete(name);
    this.removeItemFromStartingPool(name);

    // TODO: resource manager cleanup
    await worker?.container?.destroy().catch((e: unknown) => {
      this.logger.warn(`Failed to destroy worker ${name} in unregistering.`, e);
    });
  }

  /**
   * Remove item from starting pool.
   * @param {string} processName The process name (worker name).
   */
  removeItemFromStartingPool(processName: string) {
    this.startingPool.delete(processName);
  }

  /**
   * Pre-request the starting pool.
   * @return {boolean} Returns true if there's still at least one idle starting worker.
   */
  prerequestStartingPool() {
    for (const value of this.startingPool.values()) {
      if (value.estimateRequestLeft) {
        value.estimateRequestLeft--;
        return true;
      }
    }
    return false;
  }

  /**
   * Evaluate the water level.
   * @param {boolean} [expansionOnly] Whether do the expansion action only or not.
   * @return {number} How much processes (workers) should be scale. (> 0 means expand, < 0 means shrink)
   */
  evaluateWaterLevel(expansionOnly = false) {
    if (this.disposable) {
      return 0;
    }

    if (!this.data) {
      return expansionOnly ? 0 : -this.workers.size;
    }

    if (!this.workerCount) {
      return 0;
    }

    const { activeRequestCount, totalMaxActivateRequests } = this;
    const waterLevel = activeRequestCount / totalMaxActivateRequests;

    const { shrinkRedundantTimes } = this.config.worker;

    let waterLevelAction = Broker.WaterLevelAction.UNKNOWN;

    // First check is this function still existing
    if (!expansionOnly) {
      if (waterLevel <= 0.6 && this.workerCount > this.reservationCount) {
        waterLevelAction =
          waterLevelAction || Broker.WaterLevelAction.NEED_SHRINK;
      }

      // If only one worker left, and still have request, reserve it
      if (
        waterLevelAction === Broker.WaterLevelAction.NEED_SHRINK &&
        this.workerCount === 1 &&
        this.activeRequestCount !== 0
      ) {
        waterLevelAction = Broker.WaterLevelAction.NORMAL;
      }
    }

    if (waterLevel >= 0.8)
      waterLevelAction =
        waterLevelAction || Broker.WaterLevelAction.NEED_EXPAND;
    waterLevelAction = waterLevelAction || Broker.WaterLevelAction.NORMAL;

    switch (waterLevelAction) {
      case Broker.WaterLevelAction.NEED_SHRINK: {
        this.redundantTimes++;

        if (this.redundantTimes >= shrinkRedundantTimes) {
          // up to shrink
          const newMaxActivateRequests = activeRequestCount / 0.7;
          const deltaMaxActivateRequests =
            totalMaxActivateRequests - newMaxActivateRequests;
          let deltaInstance = Math.floor(
            deltaMaxActivateRequests / this.data.worker!.maxActivateRequests!
          );

          // reserve at least `this.reservationCount` instances
          if (this.workerCount - deltaInstance < this.reservationCount) {
            deltaInstance = this.workerCount - this.reservationCount;
          }

          this.redundantTimes = 0;
          return -deltaInstance;
        }

        return 0;
      }

      case Broker.WaterLevelAction.NORMAL:
      case Broker.WaterLevelAction.NEED_EXPAND:
      default: {
        this.redundantTimes = 0;
        if (waterLevelAction !== Broker.WaterLevelAction.NEED_EXPAND) return 0;

        const newMaxActivateRequests = activeRequestCount / 0.7;
        const deltaMaxActivateRequests =
          newMaxActivateRequests - totalMaxActivateRequests;
        let deltaInstanceCount = Math.ceil(
          deltaMaxActivateRequests / this.data.worker!.maxActivateRequests!
        );
        deltaInstanceCount =
          this.data.worker!.replicaCountLimit! <
          this.workerCount + deltaInstanceCount
            ? this.data.worker!.replicaCountLimit! - this.workerCount
            : deltaInstanceCount;

        return Math.max(deltaInstanceCount, 0);
      }
    }
  }

  /**
   * @type {number}
   */
  get virtualMemory() {
    return this.workerCount * this.memoryLimit;
  }

  /**
   * @type {number}
   */
  get memoryLimit() {
    return this.data?.resourceLimit?.memory || 0;
  }

  /**
   * Sync from data plane and turf ps.
   * @param workers The workers.
   */
  sync(workers: WorkerStats[]) {
    this.data = this.profiles?.get(this.name)?.toJSON(true) || null;

    /**
     * @type {Map<string, Worker>}
     */
    const newMap = new Map();
    for (const item of workers) {
      const worker = this.workers.get(item.name!);
      if (!worker) {
        // 一切以 Control Plane 已存在数据为准
        continue;
      }

      worker.sync(item);
      newMap.set(item.name, worker);
      this.workers.delete(item.name!);
    }

    for (const item of this.workers.values()) {
      item.sync(null);
      newMap.set(item.name, item);
    }

    // 将已启动完成、失败的从 `startingPool` 中移除
    for (const startingName of [...this.startingPool.keys()]) {
      const worker = newMap.get(startingName);
      if (!worker.isInitializating()) {
        this.logger.debug(
          '%s removed from starting pool due to status ' + '[%s] - [%s]',
          startingName,
          ContainerStatus[worker.containerStatus],
          worker.turfContainerStates
        );
        this.startingPool.delete(startingName);
      } else if (worker.data) {
        // 同步 startingPool 中的值
        const item = this.startingPool.get(startingName);

        /** 基本不会发生 */
        /* istanbul ignore next */
        if (!item) continue;

        item.maxActivateRequests = worker.data.maxActivateRequests;
        item.estimateRequestLeft =
          worker.data.maxActivateRequests - worker.data.activeRequestCount;
      }
    }

    this.workers = newMap;
  }

  /**
   * @type {number}
   */
  get workerCount() {
    let value = 0;
    for (const worker of this.workers.values()) {
      if (worker.isRunning()) {
        value++;
      }
    }

    // startingPool 中都是正在启动的，没有 ready，没有执行 initialize handler
    return value;
  }

  /**
   * @type {number}
   */
  get totalMaxActivateRequests() {
    let m = 0;
    for (const worker of this.workers.values()) {
      if (!worker.isRunning()) continue;
      m += worker.data?.maxActivateRequests! || 0;
    }

    // 不计算 startingPool 中的值

    return m;
  }

  /**
   * @type {number}
   */
  get activeRequestCount() {
    let a = 0;
    for (const worker of this.workers.values()) {
      if (!worker.isRunning()) continue;
      a += worker.data?.activeRequestCount || 0;
    }

    // 不考虑 starting pool 里面的值

    return a;
  }

  /**
   * @type {number}
   */
  get waterLevel() {
    return this.activeRequestCount / this.totalMaxActivateRequests;
  }

  /**
   * Get worker.
   * @param processName The process name (worker name).
   * @return The matched worker object.
   */
  getWorker(processName: string) {
    return this.workers.get(processName) || null;
  }

  updateWorkerContainerStatus(
    workerName: string,
    status: ContainerStatus,
    event: ControlPanelEvent | ContainerStatusReport
  ) {
    const worker = this.workers.get(workerName);

    worker?.updateContainerStatus(status, event);
  }

  /**
   * Get the map key by function name and `isInspector`.
   * @param functionName The function name.
   * @param isInspector Whether it's using inspector or not.
   * @return The map key.
   */
  static getKey(functionName: string, isInspector: boolean) {
    return `${functionName}:${isInspector ? 'inspector' : 'noinspector'}`;
  }

  /**
   * Check whether this broker belongs to a function profile.
   * @return {boolean} Whether it's belongs to a function profile or not.
   */
  belongsToFunctionProfile() {
    return !!this.data;
  }

  /**
   * Get the most `what` `N` workers.
   * @param n The N.
   * @param compareFn The comparation function.
   * @return The most idle N workers.
   */
  mostWhatNWorkers(
    n: number,
    compareFn: (a: Worker, b: Worker) => number
  ): { name: string; credential: string }[] {
    const workers = [...this.workers.values()].filter(w => w.isRunning());
    const nWorkers = workers.sort(compareFn).slice(0, n);

    return nWorkers.map(w => ({ name: w.name, credential: w.credential! }));
  }

  /**
   * Get the most idle N workers.
   * @param n The N.
   * @return The most idle N workers.
   */
  mostIdleNWorkers(n: number) {
    return this.mostWhatNWorkers(n, (a, b) => {
      if (a.data?.activeRequestCount! < b.data?.activeRequestCount!) {
        return -1;
      } else if (a.data?.activeRequestCount! > b.data?.activeRequestCount!) {
        return 1;
      }
      return a.credential! < b.credential! ? -1 : 1;
    });
  }

  /**
   * Get the newest N workers.
   * @param n The N.
   * @return The most idle N workers.
   */
  newestNWorkers(n: number) {
    return this.mostWhatNWorkers(n, (a, b) => {
      if (a.registerTime > b.registerTime) {
        return -1;
      } else if (a.registerTime < b.registerTime) {
        return 1;
      }
      return a.credential! < b.credential! ? -1 : 1;
    });
  }

  /**
   * Get the oldest N workers.
   * @param n The N.
   * @return The most idle N workers.
   */
  oldestNWorkers(n: number) {
    return this.mostWhatNWorkers(n, (a, b) => {
      if (a.registerTime < b.registerTime) {
        return -1;
      } else if (a.registerTime > b.registerTime) {
        return 1;
      }
      return a.credential! < b.credential! ? -1 : 1;
    });
  }

  /**
   * Do shrink draw, choose chosen workers.
   * @param countToChoose The count to choose.
   * @return The chosen workers.
   */
  shrinkDraw(countToChoose: number) {
    let strategy = this.config.worker.defaultShrinkStrategy;

    /* istanbul ignore else */
    if (this.data) {
      strategy =
        this.data.worker?.shrinkStrategy ||
        this.config.worker.defaultShrinkStrategy;
    }

    let workers = [];

    switch (strategy) {
      case 'FILO': {
        workers = this.newestNWorkers(countToChoose);
        break;
      }
      case 'FIFO': {
        workers = this.oldestNWorkers(countToChoose);
        break;
      }
      case 'LCC':
      default: {
        if (strategy !== 'LCC') {
          this.logger.warn(
            `Shrink strategy ${strategy} is not supported, fallback to LCC.`
          );
        }

        workers = this.mostIdleNWorkers(countToChoose);
      }
    }

    workers.forEach(worker => {
      this.updateWorkerContainerStatus(
        worker.name,
        ContainerStatus.PendingStop,
        ControlPanelEvent.Shrink
      );
    });

    return workers;
  }
}

export { Broker };
