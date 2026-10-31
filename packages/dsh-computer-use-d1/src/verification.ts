export interface NativeVerificationContext {
  caller: {
    call(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  }
  params: Record<string, unknown>
  signal: AbortSignal
}

export type NativeVerificationHandler = (args: Record<string, unknown>, context: NativeVerificationContext) => Promise<boolean>

const registry = new Map<string, NativeVerificationHandler>()

export function registerNativeVerification(name: string, handler: NativeVerificationHandler): void {
  registry.set(name, handler)
}

export async function runNativeVerification(
  name: string,
  args: Record<string, unknown>,
  context: NativeVerificationContext,
): Promise<boolean> {
  const handler = registry.get(name)
  if (handler === undefined) throw new Error(`Unknown native verification handler: ${name}`)
  return handler(args, context)
}
