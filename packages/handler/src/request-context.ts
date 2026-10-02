import { AsyncLocalStorage } from "node:async_hooks";

export interface HandlerRequestContext {
  requestId: string;
}

const requestContext = new AsyncLocalStorage<HandlerRequestContext>();

export function runWithHandlerRequestContext<T>(
  context: HandlerRequestContext,
  callback: () => T,
): T {
  return requestContext.run(context, callback);
}

export function getHandlerRequestContext(): HandlerRequestContext | undefined {
  return requestContext.getStore();
}
