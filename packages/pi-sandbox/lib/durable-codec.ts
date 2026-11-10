export interface DurableWireError {
  $durable: 'error';
  name: string;
  message: string;
  code?: string;
  path?: string;
  spillPath?: string;
}
export interface DurableWireHandle {
  $durable: 'handle';
  id: string;
  kind: 'binary' | 'text' | 'dir';
}
export type DurableWireValue =
  | undefined
  | null
  | boolean
  | number
  | string
  | { $durable: 'bytes'; value: string }
  | DurableWireError
  | DurableWireHandle
  | DurableWireValue[]
  | { [key: string]: DurableWireValue };

export class DurableCodec {
  static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  static encode(value: unknown): DurableWireValue {
    if (value instanceof Uint8Array) return { $durable: 'bytes', value: Buffer.from(value).toString('base64') };
    if (value instanceof Error) {
      const error: DurableWireError = { $durable: 'error', name: value.name, message: value.message };
      if ('code' in value && typeof value.code === 'string') error.code = value.code;
      if ('path' in value && typeof value.path === 'string') error.path = value.path;
      if ('spillPath' in value && typeof value.spillPath === 'string') error.spillPath = value.spillPath;
      return error;
    }
    if (Array.isArray(value)) return value.map((item) => DurableCodec.encode(item));
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, DurableCodec.encode(v)]));
    if (
      value === undefined ||
      value === null ||
      typeof value === 'boolean' ||
      typeof value === 'number' ||
      typeof value === 'string'
    )
      return value;
    throw new Error('Unsupported durable RPC value');
  }

  /** Decodes bytes everywhere; `revive` may turn other tagged records (errors, reader handles) into live values. */
  static decode(value: unknown, revive?: (record: Record<string, unknown>) => unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => DurableCodec.decode(item, revive));
    if (!DurableCodec.isRecord(value)) return value;
    if (value.$durable === 'bytes') {
      if (typeof value.value !== 'string') throw new Error('Invalid durable bytes');
      return new Uint8Array(Buffer.from(value.value, 'base64'));
    }
    const revived = revive?.(value);
    if (revived !== undefined) return revived;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, DurableCodec.decode(v, revive)]));
  }

  static isCommand(command: unknown): command is string | string[] {
    return (
      typeof command === 'string' ||
      (Array.isArray(command) && command.length > 0 && command.every((part) => typeof part === 'string'))
    );
  }
}
