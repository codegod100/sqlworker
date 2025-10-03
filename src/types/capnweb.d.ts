declare module 'capnweb' {
  export class RpcTarget {
    constructor(...args: unknown[]);
  }

  export function newWorkersRpcResponse(request: Request, target: RpcTarget): Promise<Response>;

  export function newWebSocketRpcSession<TSession = unknown>(
    url: string,
    options?: { protocols?: string | string[] },
  ): TSession & { close?: () => void | Promise<void> };
}
