import { config } from '#self/config';
import { ControlPlane } from '#self/control_plane/index';
import { DataPlane } from '#self/data_plane/index';
import { Turf } from '#self/lib/turf';
import { NoslatedClient } from '#self/sdk/index';
import { startTurfD, stopTurfD } from '#self/test/turf';
import mm from 'mm';

export abstract class MochaEnvironment {
  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    before(async function before() {
      await self.before(this);
    });

    after(async function after() {
      await self.after(this);
    });

    beforeEach(async function beforeEach() {
      await self.beforeEach(this);
    });

    afterEach(async function afterEach() {
      await self.afterEach(this);
    });
  }

  protected before(ctx: Mocha.Context): Promise<void> {
    return Promise.resolve();
  }

  protected after(ctx: Mocha.Context): Promise<void> {
    return Promise.resolve();
  }

  protected beforeEach(ctx: Mocha.Context): Promise<void> {
    return Promise.resolve();
  }

  protected afterEach(ctx: Mocha.Context): Promise<void> {
    return Promise.resolve();
  }
}

export class DefaultEnvironment extends MochaEnvironment {
  data!: DataPlane;
  control!: ControlPlane;
  agent!: NoslatedClient;
  turf!: Turf;

  async beforeEach(ctx: Mocha.Context) {
    ctx.timeout(10_000 + ctx.timeout());

    startTurfD();
    this.data = new DataPlane(config);
    this.control = new ControlPlane(config);
    this.agent = new NoslatedClient();
    this.turf = this.control.turf;

    await Promise.all([
      this.data.ready(),
      this.control.ready(),
      this.agent.start(),
    ]);
  }

  async afterEach() {
    mm.restore();

    await Promise.all([
      this.agent.close(),
      this.data.close(),
      this.control.close(),
    ]);

    stopTurfD();
  }
}
