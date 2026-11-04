import { ApiExtension } from '@nestjs/swagger';

/** Marks a route as reviewed for paired devices and instances; the allowlist in @pi-kit/protocol is generated from this mark. */
export const Remote = () => ApiExtension('x-remote', true);
