import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  requestId: string;
  sessionId?: string;
  clientDisconnected: boolean;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
