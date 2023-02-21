import { TurfContainerStates, TurfProcess } from '#self/lib/turf/types';
import type { noslated } from '#self/proto/root';
import { Config } from '#self/config';
import {
  ContainerStatus,
  ContainerStatusReport,
  TurfStatusEvent,
  ControlPlaneEvent,
} from '#self/lib/constants';
import { createDeferred, Deferred } from '#self/lib/util';
import { Container } from '../container/container_manager';
import assert from 'assert';
import { WorkerLogger } from './worker_logger';

export type WorkerStats = noslated.data.IWorkerStats;

class WorkerAdditionalData {
  maxActivateRequests;
  activeRequestCount;

  constructor(data: WorkerStats) {
    this.maxActivateRequests = data.maxActivateRequests;
    this.activeRequestCount = data.activeRequestCount;
  }
}

type WorkerOption = {
  inspect: boolean;
};
class WorkerMetadata {
  readonly credential: string | null;
  readonly processName: string | null;

  // TODO(yilong.lyl): simplify constructor params
  constructor(
    readonly funcName: string,

    readonly options: WorkerOption = { inspect: false },
    readonly disposable = false,
    readonly toReserve = false,

    _processName?: string,
    _credential?: string,
    readonly requestId?: string
  ) {
    this.processName = _processName ?? null;
    this.credential = _credential ?? null;
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

  /**
   * Underlying turf container.
   */
  container?: Container;

  #containerStatus: ContainerStatus;

  get containerStatus() {
    return this.#containerStatus;
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

  #readyDeferred: Deferred<void>;
  #initializationTimeout: number;

  #config;
  logger: WorkerLogger;
  requestId: string | undefined;
  readyTimeout: NodeJS.Timeout | undefined;

  public disposable = false;

  /**
   * Constructor
   * @param config The global configure.
   * @param name The worker name (replica name).
   * @param credential The credential.
   */
  constructor(
    workerMetadata: WorkerMetadata,
    config: Config,
    initializationTimeout?: number
  ) {
    this.#config = config;

    this.disposable = workerMetadata.disposable;
    this.#name = workerMetadata.processName!;
    this.#credential = workerMetadata.credential ?? null;

    this.#turfContainerStates = null;
    this.#pid = null;
    this.#data = null;
    this.#containerStatus = ContainerStatus.Created;

    this.#registerTime = Date.now();

    this.#initializationTimeout =
      initializationTimeout ?? config.worker.defaultInitializerTimeout;

    this.requestId = undefined;

    this.#readyDeferred = createDeferred<void>();

    this.logger = new WorkerLogger(workerMetadata);
  }

  async ready() {
    // 在 await ready 之前状态已经改变了
    if (this.#containerStatus >= ContainerStatus.Ready) {
      this.logger.statusChangedBeforeReady(
        ContainerStatus[this.#containerStatus]
      );

      if (this.#containerStatus >= ContainerStatus.PendingStop) {
        this.#readyDeferred.reject();
      }

      this.#readyDeferred.resolve();

      return this.#readyDeferred.promise;
    }

    // +100 等待 dp 先触发超时逻辑同步状态
    this.readyTimeout = setTimeout(() => {
      if (this.#containerStatus !== ContainerStatus.Ready) {
        // 状态设为 Stopped，等待 GC 回收
        this.updateContainerStatus(
          ContainerStatus.Stopped,
          ContainerStatusReport.ContainerDisconnected
        );

        this.#readyDeferred.reject(
          new Error(
            `Worker(${this.name}, ${this.credential}) initialization timeout.`
          )
        );
      }
    }, this.#initializationTimeout + 100);

    return this.#readyDeferred.promise.finally(() => {
      if (this.readyTimeout) {
        clearTimeout(this.readyTimeout);
        this.readyTimeout = undefined;
      }
    });
  }

  setContainer(container: Container) {
    this.container = container;
    container.onstatuschanged = () => {
      if (container.pid) {
        this.#pid = container.pid;
      }
      this.switchTo(container.status);
    };
    if (container.pid) {
      this.#pid = container.pid;
    }
    this.switchTo(container.status);
  }

  setReady() {
    this.#readyDeferred.resolve();
  }

  setStopped() {
    this.#readyDeferred.reject(
      new Error(
        `Worker(${this.name}, ${this.credential}) stopped unexpected after start.`
      )
    );
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

  async stop() {
    assert.ok(this.container != null, 'Worker has not bound to a container');
    return this.container?.stop();
  }

  /**
   * Sync data from data plane.
   * @param data The data object.
   * @param psData The turf ps data.
   */
  sync(data: WorkerStats | null) {
    if (data === null) {
      this.logger.syncWithNull();
    }

    this.#data = data ? new WorkerAdditionalData(data) : null;
  }

  /**
   * turf 状态仅做参考
   * Switch worker's status to another via a state machine.
   * @param found The found ps data.
   */
  switchTo(turfState: TurfContainerStates | null) {
    this.#turfContainerStates = turfState;
    switch (turfState) {
      case TurfContainerStates.init:
      case TurfContainerStates.starting:
      case TurfContainerStates.cloning:
      case TurfContainerStates.running: {
        if (
          Date.now() - this.#registerTime > this.#initializationTimeout &&
          this.#containerStatus === ContainerStatus.Created
        ) {
          this.updateContainerStatus(
            ContainerStatus.Stopped,
            TurfStatusEvent.ConnectTimeout
          );
          this.logger.statusSwitchTo(
            ContainerStatus.Stopped,
            'connect timeout'
          );
        }
        // always be Created, wait dp ContainerInstalled to Ready
        break;
      }
      case TurfContainerStates.unknown: {
        this.updateContainerStatus(
          ContainerStatus.Unknown,
          TurfStatusEvent.StatusUnknown
        );
        this.logger.statusSwitchTo(
          ContainerStatus.Unknown,
          'turf state is unknown',
          'error'
        );
        break;
      }
      case TurfContainerStates.stopping:
      case TurfContainerStates.stopped: {
        this.logger.statusSwitchTo(
          ContainerStatus.Stopped,
          'turf state is stopped/stopping'
        );
        this.updateContainerStatus(
          ContainerStatus.Stopped,
          TurfStatusEvent.StatusStopped
        );
        break;
      }
      case null: {
        // 只有 Ready 运行时无法找到的情况视为异常
        // 其他情况不做处理
        if (this.#containerStatus === ContainerStatus.Ready) {
          this.logger.statusSwitchTo(
            ContainerStatus.Stopped,
            'sandbox disappeared'
          );
          this.updateContainerStatus(
            ContainerStatus.Stopped,
            TurfStatusEvent.StatusNull
          );
        }
        break;
      }
      case TurfContainerStates.forkwait:
        //这个状态不需要处理，仅 seed 会存在
        break;
      default:
        this.logger.foundTurfState(turfState);

        if (
          Date.now() - this.#registerTime > this.#initializationTimeout &&
          this.#containerStatus === ContainerStatus.Created
        ) {
          this.updateContainerStatus(
            ContainerStatus.Stopped,
            TurfStatusEvent.ConnectTimeout
          );
          this.logger.statusSwitchTo(
            ContainerStatus.Stopped,
            'connect timeout'
          );
        }
    }
  }

  /**
   * Whether this worker is running.
   */
  isRunning() {
    return (
      this.#containerStatus === ContainerStatus.Ready ||
      this.#containerStatus === ContainerStatus.PendingStop
    );
  }

  isInitializating() {
    return this.#containerStatus === ContainerStatus.Created;
  }

  updateContainerStatusByEvent(event: ContainerStatusReport) {
    let statusTo: ContainerStatus = ContainerStatus.Unknown;

    if (event === ContainerStatusReport.ContainerInstalled) {
      statusTo = ContainerStatus.Ready;
    } else if (
      event === ContainerStatusReport.RequestDrained ||
      event === ContainerStatusReport.ContainerDisconnected
    ) {
      statusTo = ContainerStatus.Stopped;
    } else {
      statusTo = ContainerStatus.Unknown;
    }

    this.updateContainerStatus(statusTo, event);
  }

  updateContainerStatus(
    status: ContainerStatus,
    event: TurfStatusEvent | ContainerStatusReport | ControlPlaneEvent
  ) {
    if (status < this.#containerStatus) {
      ContainerStatus[ContainerStatus.Created];
      this.logger.updateContainerStatus(
        status,
        this.#containerStatus,
        event,
        'warn',
        ' is illegal.'
      );
      return;
    }

    const oldStatus = this.#containerStatus;

    this.#containerStatus = status;

    this.logger.updateContainerStatus(status, oldStatus, event);
  }
}

export { Worker, WorkerAdditionalData, WorkerMetadata as WorkerMetadata };
