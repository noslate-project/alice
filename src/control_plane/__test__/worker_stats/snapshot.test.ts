import assert from 'assert';
import _ from 'lodash';
import mm from 'mm';
import {
  Broker,
  Worker,
  WorkerStatsSnapshot,
} from '#self/control_plane/worker_stats/index';
import * as common from '#self/test/common';
import { config } from '#self/config';
import {
  FunctionProfileManager as ProfileManager,
  FunctionProfileManagerContext,
  FunctionProfileUpdateEvent,
} from '#self/lib/function_profile';
import { TurfContainerStates } from '#self/lib/turf';
import { WorkerStatus, WorkerStatusReport } from '#self/lib/constants';
import { AworkerFunctionProfile } from '#self/lib/json/function_profile';
import { NotNullableInterface } from '#self/lib/interfaces';
import * as root from '#self/proto/root';
import {
  registerContainers,
  TestContainerManager,
} from '../test_container_manager';
import { registerWorkers } from '../util';
import { DependencyContext } from '#self/lib/dependency_context';
import { EventBus } from '#self/lib/event-bus';
import { once } from 'events';
import {
  ContainerReconciler,
  ReconcilerContext,
} from '#self/control_plane/container/reconciler';

describe(common.testName(__filename), () => {
  const funcData: AworkerFunctionProfile[] = [
    {
      name: 'func',
      url: `file://${__dirname}`,
      runtime: 'aworker',
      signature: 'xxx',
      sourceFile: 'index.js',
      resourceLimit: {
        cpu: 1,
        memory: 512000000,
      },
    },
  ];

  const funcDataWithDefault = {
    ...funcData[0],
    worker: {
      fastFailRequestsOnStarting: false,
      initializationTimeout: 10000,
      maxActivateRequests: 10,
      replicaCountLimit: 10,
      reservationCount: 0,
      shrinkStrategy: 'LCC',
      v8Options: [],
      execArgv: [],
    },
  };

  const brokerData = [
    {
      functionName: 'func',
      inspector: true,
      workers: [
        {
          name: 'hello',
          credential: 'world',
          maxActivateRequests: 10,
          activeRequestCount: 1,
        },
      ],
    },
    {
      functionName: 'func',
      inspector: false,
      workers: [
        {
          // turf min sandbox name is 5
          name: 'foooo',
          credential: 'bar',
          maxActivateRequests: 10,
          activeRequestCount: 6,
        },
      ],
    },
  ];

  let profileManager: ProfileManager;
  beforeEach(async () => {
    const ctx = new DependencyContext<FunctionProfileManagerContext>();
    ctx.bindInstance('config', config);
    ctx.bindInstance('eventBus', new EventBus([FunctionProfileUpdateEvent]));
    profileManager = new ProfileManager(ctx);
    await profileManager.set(funcData, 'WAIT');
  });
  afterEach(async () => {
    mm.restore();
  });

  describe('WorkerStatsSnapshot', () => {
    let ctx: DependencyContext<
      ReconcilerContext & { containerReconciler: ContainerReconciler }
    >;
    let testContainerManager: TestContainerManager;
    let workerStatsSnapshot: WorkerStatsSnapshot;
    let clock: common.TestClock;

    beforeEach(async () => {
      ctx = new DependencyContext();
      clock = common.createTestClock({
        shouldAdvanceTime: true,
      });
      ctx.bindInstance('clock', clock);
      testContainerManager = new TestContainerManager(clock);
      ctx.bindInstance('containerManager', testContainerManager);
      ctx.bindInstance('config', config);
      ctx.bind('containerReconciler', ContainerReconciler);
      await ctx.bootstrap();
      workerStatsSnapshot = new WorkerStatsSnapshot(profileManager, config);
      await workerStatsSnapshot.ready();
    });
    afterEach(async () => {
      await ctx.dispose();
      await workerStatsSnapshot.close();
      clock.uninstall();
    });

    describe('.register()', () => {
      it('should register', () => {
        registerWorkers(workerStatsSnapshot, [
          {
            funcName: 'func',
            processName: 'hello',
            credential: 'world',
            options: { inspect: true },
            disposable: false,
            toReserve: false,
          },
          {
            funcName: 'func',
            processName: 'foooo',
            credential: 'bar',
            options: { inspect: false },
            disposable: false,
            toReserve: false,
          },
        ]);

        assert.strictEqual(workerStatsSnapshot.brokers.size, 2);
        const brokerKeys = [...workerStatsSnapshot.brokers.keys()].sort();
        const brokers = [...workerStatsSnapshot.brokers.values()].sort(
          (a, b) => {
            return a.name === b.name
              ? a.isInspector
                ? -1
                : 1
              : a.name < b.name
              ? -1
              : 1;
          }
        );
        assert.deepStrictEqual(brokerKeys, [
          'func:inspector',
          'func:noinspector',
        ]);
        brokers.forEach(b => assert(b instanceof Broker));

        const names = ['func', 'func'];
        const inspectors = [true, false];
        const datas = [funcDataWithDefault, funcDataWithDefault];
        assert.deepStrictEqual(
          brokers.map(b => b.name),
          names
        );
        assert.deepStrictEqual(
          brokers.map(b => b.isInspector),
          inspectors
        );
        assert.deepStrictEqual(
          brokers.map(b => b.data),
          datas
        );
        const startingPoolsName = ['hello', 'foooo'];
        brokers.forEach((broker, i) => {
          assert.strictEqual(broker.startingPool.size, 1);
          const sp = broker.startingPool.get(startingPoolsName[i]);
          assert.deepStrictEqual(sp, {
            credential: i === 0 ? 'world' : 'bar',
            maxActivateRequests: 10,
            estimateRequestLeft: 10,
          });
        });
        const workerNames = ['hello', 'foooo'];
        const workers: Worker[] = brokers.map(
          (b, i) => b.workers.get(workerNames[i])!
        );
        workers.forEach(w => assert(w instanceof Worker));
        assert.deepStrictEqual(
          JSON.parse(JSON.stringify(workers.map(worker => worker.toJSON()))),
          [
            {
              containerStatus: WorkerStatus.Created,
              turfContainerStates: null,
              name: 'hello',
              credential: 'world',
              registerTime: workers[0].registerTime,
              pid: null,
              data: null,
            },
            {
              containerStatus: WorkerStatus.Created,
              turfContainerStates: null,
              name: 'foooo',
              credential: 'bar',
              registerTime: workers[1].registerTime,
              pid: null,
              data: null,
            },
          ]
        );
      });

      it('should throw', () => {
        assert.throws(
          () => {
            registerWorkers(workerStatsSnapshot, [
              {
                funcName: 'non-exists',
                processName: 'aha',
                credential: 'oho',
                options: { inspect: true },
                disposable: false,
                toReserve: false,
              },
            ]);
          },
          {
            message: /No function named non-exists in function profile\./,
          }
        );
      });
    });

    describe('.getBroker()', () => {
      it('should get broker', () => {
        registerWorkers(workerStatsSnapshot, [
          {
            funcName: 'func',
            processName: 'hello',
            credential: 'world',
            options: { inspect: true },
            disposable: false,
            toReserve: false,
          },
          {
            funcName: 'func',
            processName: 'foooo',
            credential: 'bar',
            options: { inspect: false },
            disposable: false,
            toReserve: false,
          },
        ]);

        const brokers = [
          workerStatsSnapshot.getBroker('func', true)!,
          workerStatsSnapshot.getBroker('func', false)!,
        ];
        brokers.forEach(b => assert(b instanceof Broker));

        const names = ['func', 'func'];
        const inspectors = [true, false];
        const datas = [funcDataWithDefault, funcDataWithDefault];
        assert.deepStrictEqual(
          brokers.map(b => b.name),
          names
        );
        assert.deepStrictEqual(
          brokers.map(b => b.isInspector),
          inspectors
        );
        assert.deepStrictEqual(
          brokers.map(b => b.data),
          datas
        );
        const startingPoolsName = ['hello', 'foooo'];
        brokers.forEach((broker, i) => {
          assert.strictEqual(broker.startingPool.size, 1);
          const sp = broker.startingPool.get(startingPoolsName[i]);
          assert.deepStrictEqual(sp, {
            credential: i === 0 ? 'world' : 'bar',
            maxActivateRequests: 10,
            estimateRequestLeft: 10,
          });
        });
        const workerNames = ['hello', 'foooo'];
        const workers: Worker[] = brokers.map(
          (b, i) => b.workers.get(workerNames[i])!
        );
        workers.forEach(w => assert(w instanceof Worker));
        assert.deepStrictEqual(
          JSON.parse(JSON.stringify(workers.map(worker => worker.toJSON()))),
          [
            {
              containerStatus: WorkerStatus.Created,
              turfContainerStates: null,
              name: 'hello',
              credential: 'world',
              registerTime: workers[0].registerTime,
              pid: null,
              data: null,
            },
            {
              containerStatus: WorkerStatus.Created,
              turfContainerStates: null,
              name: 'foooo',
              credential: 'bar',
              registerTime: workers[1].registerTime,
              pid: null,
              data: null,
            },
          ]
        );
      });

      it('should not get broker', () => {
        registerWorkers(workerStatsSnapshot, [
          {
            funcName: 'func',
            processName: 'hello',
            credential: 'world',
            options: { inspect: true },
            disposable: false,
            toReserve: false,
          },
          {
            funcName: 'func',
            processName: 'foooo',
            credential: 'bar',
            options: { inspect: false },
            disposable: false,
            toReserve: false,
          },
        ]);
        assert.strictEqual(
          workerStatsSnapshot.getBroker('non-exists', true),
          null
        );
      });
    });

    describe('.getWorker()', () => {
      it('should get worker', () => {
        registerWorkers(workerStatsSnapshot, [
          {
            funcName: 'func',
            processName: 'hello',
            credential: 'world',
            options: { inspect: true },
            disposable: false,
            toReserve: false,
          },
          {
            funcName: 'func',
            processName: 'foooo',
            credential: 'bar',
            options: { inspect: false },
            disposable: false,
            toReserve: false,
          },
        ]);

        const workers: Worker[] = [
          workerStatsSnapshot.getWorker('func', true, 'hello')!,
          workerStatsSnapshot.getWorker('func', false, 'foooo')!,
        ];
        workers.forEach(w => assert(w instanceof Worker));
        assert.deepStrictEqual(
          JSON.parse(JSON.stringify(workers.map(worker => worker.toJSON()))),
          [
            {
              containerStatus: WorkerStatus.Created,
              turfContainerStates: null,
              name: 'hello',
              credential: 'world',
              registerTime: workers[0].registerTime,
              pid: null,
              data: null,
            },
            {
              containerStatus: WorkerStatus.Created,
              turfContainerStates: null,
              name: 'foooo',
              credential: 'bar',
              registerTime: workers[1].registerTime,
              pid: null,
              data: null,
            },
          ]
        );
      });

      it('should not get worker', () => {
        registerWorkers(workerStatsSnapshot, [
          {
            funcName: 'func',
            processName: 'hello',
            credential: 'world',
            options: { inspect: true },
            disposable: false,
            toReserve: false,
          },
          {
            funcName: 'func',
            processName: 'foooo',
            credential: 'bar',
            options: { inspect: false },
            disposable: false,
            toReserve: false,
          },
        ]);

        assert.strictEqual(
          workerStatsSnapshot.getWorker('func', false, 'hello'),
          null
        );
        assert.strictEqual(
          workerStatsSnapshot.getWorker('func', true, 'bar'),
          null
        );
      });

      it('should not get worker when broker is non-exist', () => {
        assert.strictEqual(
          workerStatsSnapshot.getWorker('non-exist', false, 'hello'),
          null
        );
      });
    });

    describe('.toProtobufObject()', () => {
      it('should to protobuf object', () => {
        registerWorkers(workerStatsSnapshot, [
          {
            funcName: 'func',
            processName: 'hello',
            credential: 'world',
            options: { inspect: true },
            disposable: false,
            toReserve: false,
          },
          {
            funcName: 'func',
            processName: 'foooo',
            credential: 'bar',
            options: { inspect: false },
            disposable: false,
            toReserve: false,
          },
        ]);

        assert.deepStrictEqual(workerStatsSnapshot.toProtobufObject(), [
          {
            name: 'func',
            inspector: true,
            profile: funcDataWithDefault,
            redundantTimes: 0,
            startingPool: [
              {
                credential: 'world',
                estimateRequestLeft: 10,
                maxActivateRequests: 10,
                workerName: 'hello',
              },
            ],
            workers: [
              {
                containerStatus: WorkerStatus.Created,
                turfContainerStates: null,
                name: 'hello',
                credential: 'world',
                data: null,
                pid: null,
                registerTime: workerStatsSnapshot.getWorker(
                  'func',
                  true,
                  'hello'
                )!.registerTime,
              },
            ],
          },
          {
            name: 'func',
            inspector: false,
            profile: funcDataWithDefault,
            redundantTimes: 0,
            startingPool: [
              {
                credential: 'bar',
                estimateRequestLeft: 10,
                maxActivateRequests: 10,
                workerName: 'foooo',
              },
            ],
            workers: [
              {
                containerStatus: WorkerStatus.Created,
                turfContainerStates: null,
                name: 'foooo',
                credential: 'bar',
                data: null,
                pid: null,
                registerTime: workerStatsSnapshot.getWorker(
                  'func',
                  false,
                  'foooo'
                )!.registerTime,
              },
            ],
          },
        ]);
      });

      it('should to protobuf object with worker data', () => {
        registerWorkers(workerStatsSnapshot, [
          {
            funcName: 'func',
            processName: 'hello',
            credential: 'world',
            options: { inspect: true },
            disposable: false,
            toReserve: false,
          },
        ]);
        workerStatsSnapshot.sync(brokerData);

        assert.deepStrictEqual(workerStatsSnapshot.toProtobufObject(), [
          {
            name: 'func',
            inspector: true,
            profile: funcDataWithDefault,
            redundantTimes: 0,
            startingPool: [
              {
                credential: 'world',
                estimateRequestLeft: 9,
                maxActivateRequests: 10,
                workerName: 'hello',
              },
            ],
            workers: [
              {
                containerStatus: WorkerStatus.Created,
                turfContainerStates: null,
                name: 'hello',
                credential: 'world',
                data: {
                  maxActivateRequests: 10,
                  activeRequestCount: 1,
                },
                pid: null,
                registerTime: workerStatsSnapshot.getWorker(
                  'func',
                  true,
                  'hello'
                )!.registerTime,
              },
            ],
          },
        ]);
      });
    });

    describe('.sync()', () => {
      it('should sync', async () => {
        registerWorkers(workerStatsSnapshot, [
          {
            funcName: 'func',
            processName: 'hello',
            credential: 'world',
            options: { inspect: true },
            disposable: false,
            toReserve: false,
          },
          {
            funcName: 'func',
            processName: 'foooo',
            credential: 'bar',
            options: { inspect: false },
            disposable: false,
            toReserve: false,
          },
        ]);

        registerContainers(testContainerManager, workerStatsSnapshot, [
          { pid: 1, name: 'foooo', status: TurfContainerStates.running },
        ]);
        await testContainerManager.reconcileContainers();

        workerStatsSnapshot.sync([
          ...brokerData,
          {
            functionName: 'hoho',
            inspector: false,
            workers: [
              {
                name: 'aho',
                credential: 'aha',
                maxActivateRequests: 10,
                activeRequestCount: 6,
              },
            ],
          },
        ]);

        // hoho should be ignored
        assert.strictEqual(workerStatsSnapshot.brokers.size, 2);

        const brokers = [
          workerStatsSnapshot.getBroker('func', true)!,
          workerStatsSnapshot.getBroker('func', false)!,
        ];

        const inspectors = [true, false];
        const workerNames = ['hello', 'foooo'];
        const workerCredentials = ['world', 'bar'];
        const turfContainerStateses = [null, TurfContainerStates.running];
        const containerStatus: WorkerStatus[] = [
          WorkerStatus.Created,
          WorkerStatus.Created,
        ];
        const pids = [null, 1];

        brokers.forEach((broker, i) => {
          assert.strictEqual(broker.name, 'func');
          assert.strictEqual(broker.isInspector, inspectors[i]);
          assert.deepStrictEqual(
            broker.data,
            profileManager.get('func')!.toJSON(true)
          );
          assert.strictEqual(broker.workers.size, 1);
          assert.strictEqual(broker.startingPool.size, 1);

          const worker: Partial<Worker> = JSON.parse(
            JSON.stringify(broker.workers.get(workerNames[i]))
          );
          assert.deepStrictEqual(worker, {
            containerStatus: containerStatus[i],
            turfContainerStates: turfContainerStateses[i],
            name: workerNames[i],
            credential: workerCredentials[i],
            pid: pids[i],
            data: _.pick(JSON.parse(JSON.stringify(brokerData[i].workers[0])), [
              'activeRequestCount',
              'maxActivateRequests',
            ]),
            registerTime: worker.registerTime,
          });
        });

        // 事件更新，container ready
        updateWorkerContainerStatus(workerStatsSnapshot, {
          functionName: 'func',
          name: 'hello',
          isInspector: true,
          event: WorkerStatusReport.ContainerInstalled,
          requestId: '',
        });

        registerContainers(testContainerManager, workerStatsSnapshot, [
          /** foooo has been disappeared */
          { pid: 2, name: 'hello', status: TurfContainerStates.running },
        ]);
        await testContainerManager.reconcileContainers();
        workerStatsSnapshot.sync(brokerData);

        const _turfContainerStateses = [
          TurfContainerStates.running,
          TurfContainerStates.unknown,
        ];
        const _containerStatus: WorkerStatus[] = [
          WorkerStatus.Ready,
          WorkerStatus.Unknown,
        ];
        const _pids = [2, 1];

        brokers.forEach((broker, i) => {
          assert.strictEqual(broker.name, 'func');
          assert.strictEqual(broker.isInspector, inspectors[i]);
          assert.deepStrictEqual(
            broker.data,
            profileManager.get('func')!.toJSON(true)
          );
          assert.strictEqual(broker.workers.size, 1);
          assert.strictEqual(broker.startingPool.size, 0);

          const worker: Partial<Worker> = JSON.parse(
            JSON.stringify(broker.workers.get(workerNames[i]))
          );
          assert.deepStrictEqual(worker, {
            containerStatus: _containerStatus[i],
            turfContainerStates: _turfContainerStateses[i],
            name: workerNames[i],
            credential: workerCredentials[i],
            pid: _pids[i],
            data: _.pick(JSON.parse(JSON.stringify(brokerData[i].workers[0])), [
              'activeRequestCount',
              'maxActivateRequests',
            ]),
            registerTime: worker.registerTime,
          });
        });
      });

      it('should sync that not in profile', async () => {
        registerWorkers(workerStatsSnapshot, [
          {
            funcName: 'func',
            processName: 'hello',
            credential: 'world',
            options: { inspect: true },
            disposable: false,
            toReserve: false,
          },
          {
            funcName: 'func',
            processName: 'foooo',
            credential: 'bar',
            options: { inspect: false },
            disposable: false,
            toReserve: false,
          },
        ]);

        await profileManager.set([], 'WAIT');

        registerContainers(testContainerManager, workerStatsSnapshot, [
          { pid: 1, name: 'foooo', status: TurfContainerStates.running },
          { pid: 2, name: 'hello', status: TurfContainerStates.starting },
        ]);
        await testContainerManager.reconcileContainers();

        workerStatsSnapshot.sync([brokerData[1]]);

        const brokers = [
          workerStatsSnapshot.getBroker('func', true)!,
          workerStatsSnapshot.getBroker('func', false)!,
        ];
        const inspectors = [true, false];
        const workerNames = ['hello', 'foooo'];
        const workerCredentials = ['world', 'bar'];
        const turfContainerStates = [
          TurfContainerStates.starting,
          TurfContainerStates.running,
        ];
        const pids = [2, 1];

        brokers.forEach((broker, i) => {
          assert.strictEqual(broker.name, 'func');
          assert.strictEqual(broker.isInspector, inspectors[i]);
          assert.strictEqual(broker.data, null);
          assert.strictEqual(broker.workers.size, 1);
          assert.strictEqual(broker.startingPool.size, 1);

          const worker = JSON.parse(
            JSON.stringify(broker.workers.get(workerNames[i]))
          );
          assert.deepStrictEqual(worker, {
            containerStatus: WorkerStatus.Created,
            turfContainerStates: turfContainerStates[i],
            name: workerNames[i],
            credential: workerCredentials[i],
            pid: pids[i],
            data:
              i === 0
                ? null
                : _.pick(JSON.parse(JSON.stringify(brokerData[i].workers[0])), [
                    'activeRequestCount',
                    'maxActivateRequests',
                  ]),
            registerTime: worker.registerTime,
          });

          // Suppress ready rejection.
          broker
            .getWorker(workerNames[i])
            ?.updateWorkerStatusByReport(WorkerStatusReport.ContainerInstalled);
        });

        registerContainers(testContainerManager, workerStatsSnapshot, [
          { pid: 1, name: 'foooo', status: TurfContainerStates.stopped },
          { pid: 2, name: 'hello', status: TurfContainerStates.stopping },
        ]);
        await testContainerManager.reconcileContainers();
        workerStatsSnapshot.sync([brokerData[1]]);

        const _turfContainerStates = [
          TurfContainerStates.stopping,
          TurfContainerStates.stopped,
        ];

        brokers.forEach((broker, i) => {
          assert.strictEqual(broker.name, 'func');
          assert.strictEqual(broker.isInspector, inspectors[i]);
          assert.strictEqual(broker.data, null);
          assert.strictEqual(broker.workers.size, 1);
          assert.strictEqual(broker.startingPool.size, 0);

          const worker: Partial<Worker> = JSON.parse(
            JSON.stringify(broker.workers.get(workerNames[i]))
          );
          assert.deepStrictEqual(worker, {
            containerStatus: WorkerStatus.Stopped,
            turfContainerStates: _turfContainerStates[i],
            name: workerNames[i],
            credential: workerCredentials[i],
            pid: pids[i],
            data:
              i === 0
                ? null
                : _.pick(JSON.parse(JSON.stringify(brokerData[i].workers[0])), [
                    'activeRequestCount',
                    'maxActivateRequests',
                  ]),
            registerTime: worker.registerTime,
          });
        });
      });
    });

    describe('.correct()', () => {
      it('should correct gc stopped and unknown container', async () => {
        registerWorkers(workerStatsSnapshot, [
          {
            funcName: 'func',
            processName: 'hello',
            credential: 'world',
            options: { inspect: true },
            disposable: false,
            toReserve: false,
          },
          {
            funcName: 'func',
            processName: 'foooo',
            credential: 'bar',
            options: { inspect: false },
            disposable: false,
            toReserve: false,
          },
        ]);
        registerContainers(testContainerManager, workerStatsSnapshot, [
          { name: 'hello', pid: 1, status: TurfContainerStates.running },
          { name: 'foooo', pid: 1, status: TurfContainerStates.running },
        ]);

        updateWorkerContainerStatus(workerStatsSnapshot, {
          functionName: 'func',
          isInspector: true,
          event: WorkerStatusReport.ContainerInstalled,
          name: 'hello',
          requestId: '',
        });
        // Suppress ready rejection
        updateWorkerContainerStatus(workerStatsSnapshot, {
          functionName: 'func',
          isInspector: false,
          event: WorkerStatusReport.ContainerInstalled,
          name: 'foooo',
          requestId: '',
        });

        updateWorkerContainerStatus(workerStatsSnapshot, {
          functionName: 'func',
          isInspector: false,
          event: WorkerStatusReport.ContainerDisconnected,
          name: 'foooo',
          requestId: '',
        });

        assert.strictEqual(
          workerStatsSnapshot.getBroker('func', true)!.workers.size,
          1
        );
        assert.strictEqual(
          workerStatsSnapshot.getBroker('func', false)!.workers.size,
          1
        );

        let workerStoppedFuture = once(workerStatsSnapshot, 'workerStopped');
        // 回收 Stopped
        await workerStatsSnapshot.correct();

        assert.strictEqual(
          workerStatsSnapshot.getBroker('func', true)!.workers.size,
          1
        );
        assert.strictEqual(
          workerStatsSnapshot.getBroker('func', false)!.workers.size,
          0
        );
        assert(testContainerManager.getContainer('foooo') == null);

        {
          const [, /* state */ broker, worker] = await workerStoppedFuture;
          assert.strictEqual(worker.name, 'foooo');
        }

        registerContainers(testContainerManager, workerStatsSnapshot, [
          { pid: 2, name: 'hello', status: TurfContainerStates.unknown },
        ]);
        await testContainerManager.reconcileContainers();
        workerStatsSnapshot.sync(brokerData);

        workerStoppedFuture = once(workerStatsSnapshot, 'workerStopped');
        // 回收 Unknown
        await workerStatsSnapshot.correct();

        assert.strictEqual(
          workerStatsSnapshot.getBroker('func', true)!.workers.size,
          0
        );
        assert.strictEqual(
          workerStatsSnapshot.getBroker('func', false)!.workers.size,
          0
        );

        assert(testContainerManager.getContainer('hello') == null);

        {
          const [, /* state */ broker, worker] = await workerStoppedFuture;
          assert.strictEqual(worker.name, 'hello');
        }

        await profileManager.set([], 'WAIT');

        workerStatsSnapshot.sync([]);

        // 配置更新后，回收无用 borker
        await workerStatsSnapshot.correct();

        assert.strictEqual(workerStatsSnapshot.getBroker('func', true), null);
        assert.strictEqual(workerStatsSnapshot.getBroker('func', false), null);
      });
    });
  });
});

function updateWorkerContainerStatus(
  snapshot: WorkerStatsSnapshot,
  report: NotNullableInterface<root.noslated.data.IContainerStatusReport>
) {
  const { functionName, isInspector, name, event } = report;

  const worker = snapshot.getWorker(functionName, isInspector, name);

  if (worker) {
    worker.updateWorkerStatusByReport(event as WorkerStatusReport);

    // 如果已经 ready，则从 starting pool 中移除
    if (worker.workerStatus === WorkerStatus.Ready) {
      const broker = snapshot.getBroker(functionName, isInspector);
      broker?.removeItemFromStartingPool(worker.name);
    }
  }
}
