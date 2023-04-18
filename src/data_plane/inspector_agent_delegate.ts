import {
  InspectorAgentDelegate,
  InspectorTargetDescriptor,
} from '#self/diagnostics/inspector_agent_delegate';
import { loggers } from '#self/lib/loggers';
import { aworker } from '#self/proto/aworker';
import { DataFlowController } from './data_flow_controller';

const logger = loggers.get('inspector delegate');

export class DataPlaneInspectorAgentDelegate implements InspectorAgentDelegate {
  constructor(private dataFlowController: DataFlowController) {}

  getTargetDescriptorOf(
    cred: string,
    target: aworker.ipc.IInspectorTarget
  ): InspectorTargetDescriptor {
    const broker = this.dataFlowController.credentialBrokerMap.get(cred);
    if (broker == null) {
      logger.info('inspector target not found', cred);
      return target;
    }
    const worker = broker.getWorkerInfo(cred);
    if (worker == null) {
      logger.info('inspector target worker not found', cred);
      return target;
    }
    return {
      id: worker.name,
      title: worker.name,
      url: `noslate://workers/${broker.name}/${worker.name}`,
    };
  }
}
