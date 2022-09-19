import path from 'path';

const projectRoot = path.resolve(__dirname, '../../');

export default {
  projectRoot,

  plane: {
    dataPlaneCount: 1,
    controlPlaneCount: 1,
    planeFirstConnectionTimeout: 10_000,
  },

  controlPlane: {
    // worker launcher 扩容并发度
    expandConcurrency: 2,
    // worker launcher 扩容队列消费间隔
    expandInterval: 0
  },

  dirs: {
    aliceSock: path.join(projectRoot, '.code/socks'),
    aliceWork: path.join(projectRoot, '.code'),
  },

  aliceAddonType: 'Release',
  virtualMemoryPoolSize: '1gb',
  worker: {
    controlPlaneConnectTimeout: 10_000,
    defaultShrinkStrategy: 'LCC',
    gcLogDelay: 5 * 1000 * 60,
    reservationCountPerFunction: 0,
    maxActivateRequests: 10,
    defaultInitializerTimeout: 10_000,
    replicaCountLimit: 10,
    // Alice will check water level regularly. If water level is always too low
    // in continuous `shrinkRedundantTimes` times, some worker(s) will be
    // shrinked.
    shrinkRedundantTimes: 60,
  },
  starter: {
    // TODO(chengzhong.wcz): rename to aworker.
    aworker: {
      defaultSeedScript: null,
      defaultEnvirons: {},
    },
  },

  turf: {
    bin: path.join(projectRoot, 'bin/turf'),
    startTurfDOutput: false,
    deleteAllContainersBeforeStart: false,
  },

  delegate: {
    sockConnectTimeout: 5000,
    resourceAcquisitionTimeout: 10_000,

    // Per-function storage max byte length:
    // kvStoragePerNamespaceCapacity * kvStoragePerNamespaceMaxByteLength
    kvStoragePerNamespaceCapacity: 8,
    kvStoragePerNamespaceMaxSize: 4096,
    kvStoragePerNamespaceMaxByteLength: 256 * 1024 * 1024,
  },

  systemCircuitBreaker: {
    requestCountLimit: 10000,
    pendingRequestCountLimit: 1000,
    systemLoad1Limit: 10,
  },

  logger: {
    level: 'info',
    dir: path.join(projectRoot, '.code/logs'),
  },

  dispatchStrategy: {
    idrs: {
      // 默认十分钟
      idleDuration: 10 * 60 * 1000,
    },
  },

  grpc: {
    /**
     * @see https://github.com/grpc/grpc-node/tree/master/packages/grpc-js#supported-channel-options
     */
    channelOptions: {
      'grpc.max_receive_message_length': /* 10M */10 * 1024 * 1024,
      'grpc.max_send_message_length': /* 10M */10 * 1024 * 1024,
      'grpc-node.max_session_memory': /* 10M, in megabytes */10,
    },
  },
};
