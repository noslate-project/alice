import * as common from '#self/test/common';
import { testWorker } from '#self/test/util';
import { DefaultEnvironment } from '#self/test/env/environment';
import { baselineDir } from '#self/test/common';
import {
  AworkerFunctionProfile,
  NodejsFunctionProfile,
} from '#self/lib/json/function_profile';

describe(common.testName(__filename), function () {
  // Debug version of Node.js may take longer time to bootstrap.
  this.timeout(30_000);
  const env = new DefaultEnvironment({
    config: common.extendDefaultConfig({
      dataPlane: {
        daprAdaptorModulePath: common.daprAdaptorDir,
      },
    }),
  });

  it('should dapr adaptor binding response with metadata on aworker', async () => {
    const profile: AworkerFunctionProfile = {
      name: 'aworker_dapr_binding_response',
      runtime: 'aworker',
      url: `file://${baselineDir}/aworker_dapr`,
      sourceFile: 'binding.js',
      signature: 'md5:234234',
    };

    await env.agent.setFunctionProfile([profile]);

    function req() {
      return testWorker(env.agent, {
        profile,
        input: {
          data: Buffer.from(''),
          metadata: {
            headers: [['DAPR_OPERATION', 'response-metadata']],
          },
        },
        expect: {
          status: 200,
          data: Buffer.from(
            JSON.stringify({
              foo: 'bar',
            })
          ),
          metadata: {
            headers: [['x-response-data-type', 'json']],
          },
        },
      });
    }

    await req();
  });

  it('should dapr adaptor binding response with metadata on nodejs', async () => {
    const profile: NodejsFunctionProfile = {
      name: 'node_worker_dapr_binding',
      runtime: 'nodejs',
      url: `file://${baselineDir}/node_worker_dapr`,
      handler: 'binding.handler',
      signature: 'md5:234234',
    };

    await env.agent.setFunctionProfile([profile]);

    function req() {
      return testWorker(env.agent, {
        profile,
        input: {
          data: Buffer.from(''),
          metadata: {
            headers: [['DAPR_OPERATION', 'response-metadata']],
          },
        },
        expect: {
          status: 200,
          data: Buffer.from(
            JSON.stringify({
              status: 200,
              text: JSON.stringify({ foo: 'bar' }),
            })
          ),
          metadata: {
            headers: [['x-response-data-type', 'json']],
          },
        },
      });
    }

    await req();
  });
});
