/**
 * LocalLambdaAdapter — noop Lambda client for local mode.
 *
 * In local dev there are no Lambda functions to invoke. This adapter
 * returns a success response for InvokeCommand so that services that
 * call Lambda (e.g. voice cloning) don't crash, but also don't
 * actually invoke anything.
 */
export class LocalLambdaAdapter {
  async send(command: {
    constructor: { name: string };
    input: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const cmdName = command.constructor.name;

    switch (cmdName) {
      case 'InvokeCommand': {
        console.warn(
          `[local] Lambda invoke stubbed: ${command.input.FunctionName}`,
        );
        return {
          $metadata: { httpStatusCode: 200 },
          StatusCode: 200,
          Payload: Buffer.from(JSON.stringify({ status: 'local-noop' })),
        };
      }

      default:
        throw new Error(`LocalLambdaAdapter: unsupported command "${cmdName}"`);
    }
  }
}
