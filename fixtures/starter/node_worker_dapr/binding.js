'use strict';

exports.handler = async (ctx, req, res) => {
  const dapr = ctx.Dapr['1.0'];
  try {
    const resp = await dapr.binding({
      name: 'getOp',
      operation: 'say',
      body: 'aworker',
      metadata: {
        age: 10,
      },
    });

    res.end(JSON.stringify({
      status: resp.status,
      data: await resp.text(),
    }));
  } catch (e) {
    res.end(JSON.stringify({ error: e.message }));
  }
};
