import { TurfContainerStates, TurfProcess } from '#self/lib/turf/types';
import type { alice } from '#self/proto/root';
import { PrefixedLogger } from '#self/lib/loggers';
import { Config } from '#self/config';
import { ContainerStatus, ContainerStatusReport } from '#self/lib/constants';
import { performance } from 'perf_hooks';

export type WorkerStats = alice.data.IWorkerStats;

class WorkerAdditionalData {
  maxActivateRequests;
  activeRequestCount;

  constructor(data: WorkerStats) {
    this.maxActivateRequests = data.maxActivateRequests;
    this.activeRequestCount = data.activeRequestCount;
  }
}

class Worker {
  /**
   * Find ps data via name
   * @param {TurfPsItem[]} psData The ps data.
   * @param {string} name The worker name.
   * @return {TurfPsItem | null} The result.
   */
  static findPsData(psData: TurfProcess[], name: string) {
    for (const data of psData) {
      if (data.name === name) return data;
    }
    return null;
  }

  #containerStatus: ContainerStatus;

  #latestUpdateContainerStatusTimestamp: number;

  get containerStatus() {
    return this.#containerStatus
  }

  /**
   * The container states.
   */
  #turfContainerStates: TurfContainerStates | null;

  /**
   * The container states.
   */
  get turfContainerStates() {
    return this.#turfContainerStates;
  }

  /**
   * The replica name.
   */
  #name: string;

  /**
   * The replica name.
   */
  get name() {
    return this.#name;
  }

  /**
   * The credential.
   */
  #credential: string | null;

  /**
   * The credential.
   */
  get credential() {
    return this.#credential;
  }

  /**
   * The pid.
   */
  #pid: number | null;

  /**
   * The pid.
   */
  get pid() {
    return this.#pid;
  }

  /**
   * The worker additional data.
   */
  #data: WorkerAdditionalData | null;

  /**
   * The worker additional data.
   */
  get data() {
    return this.#data;
  }

  /**
   * The register time.
   */
  #registerTime: number;

  /**
   * The register time.
   */
  get registerTime() {
    return this.#registerTime;
  }

  #config;
  logger: PrefixedLogger;
  requestId: string | undefined;

  /**
   * Constructor
   * @param config The global configure.
   * @param name The worker name (replica name).
   * @param credential The credential.
   */
  constructor(config: Config, name: string, credential: string | null = null, public disposable: boolean = false) {
    this.#config = config;
    this.#name = name;
    this.#credential = credential;

    this.#turfContainerStates = null;
    this.#pid = null;
    this.#data = null;
    this.#containerStatus = ContainerStatus.Created;
    this.#latestUpdateContainerStatusTimestamp = performance.now();

    this.#registerTime = Date.now();

    this.logger = new PrefixedLogger('worker_stats worker', this.#name);
    this.requestId = undefined;
  }

  toJSON() {
    return {
      name: this.name,
      credential: this.credential,
      pid: this.pid,

      turfContainerStates: this.turfContainerStates,
      containerStatus: this.#containerStatus,

      registerTime: this.registerTime,

      data: JSON.parse(JSON.stringify(this.#data)),
    };
  }

  /**
   * Sync data from data plane and turf.
   * @param data The data object.
   * @param psData The turf ps data.
   */
  sync(data: WorkerStats | null, psData: TurfProcess[], timestamp: number) {
    if (data === null) {
      this.logger.debug('Sync with null.');
    }

    this.#data = data ? new WorkerAdditionalData(data) : null;
    const found = Worker.findPsData(psData, this.name);
    this.switchTo(found, timestamp);
    this.#pid = found?.pid || null;
    this.#turfContainerStates = found?.status || null;
  }

  /**
   * turf 状态仅做参考
   * Switch worker's status to another via a state machine.
   * @param found The found ps data.
   */
  switchTo(found: TurfProcess | null, timestamp: number) {
    const turfState = found?.status || null;

    switch (turfState) {
      case TurfContainerStates.init:
      case TurfContainerStates.starting:
      case TurfContainerStates.cloning:
      case TurfContainerStates.running: {
        if (Date.now() - this.#registerTime > this.#config.worker.controlPlaneConnectTimeout && this.#containerStatus === ContainerStatus.Created) {
          this.updateContainerStatus(ContainerStatus.Stopped, timestamp);
          this.logger.error('switch worker container status to [Stopped], because connect timeout.');
        }
        // always be Created, wait dp ContainerInstalled to Ready
        break;
      }
      case TurfContainerStates.unknown: {
        this.updateContainerStatus(ContainerStatus.Unknown, timestamp);
        this.logger.error('switch worker container status to [Unknown], because turf state is unknown.');
        break;
      }
      case TurfContainerStates.stopping:
      case TurfContainerStates.stopped: {
        this.logger.error('switch worker container status to [Stopped], because turf state is stopped/stopping.');
        this.updateContainerStatus(ContainerStatus.Stopped, timestamp);
        break;
      }
      case null: {
        // 只有 Ready 运行时无法找到的情况视为异常
        // 其他情况不做处理
        if (this.#containerStatus === ContainerStatus.Ready) {
          this.updateContainerStatus(ContainerStatus.Stopped, timestamp);
          this.logger.error('switch worker container status to [Stopped], because sandbox disappeared.');
        }
        break;
      }
      case TurfContainerStates.forkwait:
        //这个状态不需要处理，仅 seed 会存在
        break;
      default:
        this.logger.info('found turf state: ', turfState);

        if (Date.now() - this.#registerTime > this.#config.worker.controlPlaneConnectTimeout && this.#containerStatus === ContainerStatus.Created) {
          this.updateContainerStatus(ContainerStatus.Stopped, timestamp);
          this.logger.error('switch worker container status to [Stopped], because connect timeout.');
        }
    }
  }

  /**
   * Whether this worker is running.
   */
  isRunning() {
    return this.#containerStatus === ContainerStatus.Ready || this.#containerStatus === ContainerStatus.PendingStop;
  }

  isInitializating() {
    return this.#containerStatus === ContainerStatus.Created;
  }

  updateContainerStatusByEvent(event: ContainerStatusReport, timestamp: number) {
    let statusTo: ContainerStatus = ContainerStatus.Unknown;

    if (event === ContainerStatusReport.ContainerInstalled) {
      statusTo = ContainerStatus.Ready;
    } else if (event === ContainerStatusReport.RequestDrained || event === ContainerStatusReport.ContainerDisconnected) {
      statusTo = ContainerStatus.Stopped;
    } else {
      statusTo = ContainerStatus.Unknown;
    }

    this.logger.info(`update status to [${ContainerStatus[statusTo]}] from [${ContainerStatus[this.#containerStatus]}] by event [${event}] at [${timestamp}].`);
    this.updateContainerStatus(statusTo, timestamp);
  }

  updateContainerStatus(status: ContainerStatus, timestamp: number) {
    if (status < this.#containerStatus) return;

    const oldStatus = this.#containerStatus;

    this.#containerStatus = status;
    this.#latestUpdateContainerStatusTimestamp = timestamp;

    this.logger.info(`set new container status [${ContainerStatus[status]}] from [${ContainerStatus[oldStatus]}] on [${timestamp}].`);
  }
}

export {
  Worker,
  WorkerAdditionalData,
};
