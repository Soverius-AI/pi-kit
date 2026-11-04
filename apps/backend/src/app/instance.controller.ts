import { Body, Controller, Delete, Get, Param, Patch, Put } from '@nestjs/common';
import {
  EnvironmentSchema,
  InstanceAccessPreferencesSchema,
  RenameEnvironmentSchema,
  StoredDeviceGrantSchema,
  StoredDeviceGrantsSchema,
  PeerOriginSchema,
  type Environment,
  type InstanceAccessPreferences,
  type StoredDeviceGrant,
} from '@pi-kit/protocol';
import { z } from 'zod';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Responds, Remote } from '../contract';
import { InstanceRepository } from '../db/instance.repository';
import { PeersRepository } from '../db/peers.repository';

/** Master-token protected local owner API. Remote access exposes only GET /instance. */
@ApiTags('instance')
@Controller('instance')
export class InstanceController {
  constructor(
    private readonly instances: InstanceRepository,
    private readonly peers: PeersRepository,
  ) {}

  @Remote()
  @Get()
  @ApiOperation({
    summary: 'Read this environment',
    description: 'Stable owner identity and freely editable display name. Does not enable remote access.',
  })
  @Responds(EnvironmentSchema)
  identity(): Environment {
    return this.instances.identity();
  }

  @Patch()
  @ApiOperation({
    summary: 'Rename this environment',
    description: 'Owner-only label change; identity, project paths, threads and publication are unchanged.',
  })
  @Responds(EnvironmentSchema)
  rename(@Body({ schema: RenameEnvironmentSchema }) body: z.infer<typeof RenameEnvironmentSchema>): Environment {
    return this.instances.rename(body.name);
  }

  @Get('access')
  @ApiOperation({
    summary: 'Read remembered access consent',
    description: 'Private desktop-owner API; never proxied to a paired phone.',
  })
  @Responds(InstanceAccessPreferencesSchema)
  access(): InstanceAccessPreferences {
    return this.instances.preferences();
  }

  @Put('access')
  @ApiOperation({
    summary: 'Remember explicit access consent',
    description: 'Private desktop-owner API; shutdown is distinct from disabling access.',
  })
  @Responds(InstanceAccessPreferencesSchema)
  setAccess(
    @Body({ schema: InstanceAccessPreferencesSchema }) body: InstanceAccessPreferences,
  ): InstanceAccessPreferences {
    return this.instances.setPreferences(body);
  }

  @Put('endpoint')
  @ApiOperation({
    summary: 'Remember the owned HTTPS endpoint',
    description: 'Private desktop-owner callback after verifying Serve publication; never enables access itself.',
  })
  @Responds(z.object({ saved: z.literal(true) }))
  endpoint(@Body({ schema: z.object({ origin: PeerOriginSchema }).strict() }) body: { origin: string }): {
    saved: true;
  } {
    this.peers.setOrigin(body.origin);
    return { saved: true };
  }

  @Get('devices')
  @ApiOperation({
    summary: 'Load private device grants',
    description:
      'Private desktop-owner persistence API. Contains credential hashes and CSRF state, never raw device cookies. Not available to phones.',
  })
  @Responds(StoredDeviceGrantsSchema)
  devices(): StoredDeviceGrant[] {
    return this.instances.devices();
  }

  @Put('devices')
  @ApiOperation({
    summary: 'Commit private device approval',
    description:
      'Private desktop-owner API; commit precedes issuing the device cookie. Revoked identities cannot be reactivated.',
  })
  @Responds(z.object({ saved: z.literal(true) }))
  saveDevice(@Body({ schema: StoredDeviceGrantSchema }) body: StoredDeviceGrant): { saved: true } {
    this.instances.saveDevice(body);
    return { saved: true };
  }

  @Delete('devices/:id')
  @ApiOperation({
    summary: 'Persist device revocation',
    description: 'Private desktop-owner API; retains a revocation tombstone across restarts.',
  })
  @Responds(z.object({ revoked: z.literal(true) }))
  revokeDevice(@Param('id') id: string): { revoked: true } {
    this.instances.revokeDevice(id);
    return { revoked: true };
  }
}
