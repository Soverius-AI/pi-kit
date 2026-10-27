import { existsSync } from 'node:fs';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import {
  CwdQuerySchema,
  type InstallPackage,
  InstallPackageSchema,
  type PackageActionResult,
  PackageActionResultSchema,
  type PackageDetail,
  PackageDetailQuerySchema,
  PackageDetailSchema,
  PackageEnabledRequestSchema,
  PackageSearchQuerySchema,
  type PackageSearchResponse,
  PackageSearchResponseSchema,
  type PackagesOverview,
  PackagesOverviewSchema,
} from '@pi-kit/protocol';
import type { z } from 'zod';
import type { BackendConfig } from '../app/config';
import { CONFIG } from '../app/config.token';
import { Fails, Responds } from '../contract';
import { PackagesService } from './packages.service';

const PACKAGE_ID = { name: 'id', description: 'The package: `<scope>:<source>`, URL-encoded, as `GET /api/packages` lists it.', schema: { type: 'string' } } as const;
const NO_PACKAGE = 'pi does not list that package.';

/**
 * Pi packages: what is installed, installing from npm, git or a folder through pi's package manager, updates, and the search the "Add a package" wizard browses.
 * `cwd` names the project folder whose own packages are listed too (a trusted folder); the backend's default folder without it, as the resources route does.
 */
@ApiTags('packages')
@Controller('packages')
export class PackagesController {
  constructor(
    private readonly packages: PackagesService,
    @Inject(CONFIG) private readonly backend: BackendConfig,
  ) {}

  private cwdOf(cwd: string | undefined): string {
    return cwd && existsSync(cwd) ? cwd : this.backend.defaultCwd;
  }

  @Get()
  @ApiOperation({ summary: 'List the installed packages', description: "Lists the packages in pi's settings (and the folder's, when it is trusted): where each comes from, whether it is on, what it brings, when it was installed, and an update the last check found." })
  @Responds(PackagesOverviewSchema)
  list(@Query({ schema: CwdQuerySchema }) query: z.infer<typeof CwdQuerySchema>): Promise<PackagesOverview> {
    return this.packages.list(this.cwdOf(query.cwd));
  }

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Install a package',
    description: "Installs a package from npm (`npm:name`), git (`git:host/path`, a repository URL) or a folder on this machine through pi's package manager, writes it into pi's settings, and reloads the idle open threads.",
  })
  @Responds(PackageActionResultSchema)
  @Fails({ 400: 'pi could not install the source, or the folder is not a pi package.', 409: 'The package is installed already, or the folder is not trusted.' })
  install(@Query({ schema: CwdQuerySchema }) query: z.infer<typeof CwdQuerySchema>, @Body({ schema: InstallPackageSchema }) body: InstallPackage): Promise<PackageActionResult> {
    return this.packages.install(this.cwdOf(query.cwd), body);
  }

  @Post('outdated')
  @HttpCode(200)
  @ApiOperation({ summary: 'Check the packages for updates', description: 'Asks pi (and the npm registry for the newest version) whether an installed npm or git package is behind, and answers with the list, the ones that are marked.' })
  @Responds(PackagesOverviewSchema)
  outdated(@Query({ schema: CwdQuerySchema }) query: z.infer<typeof CwdQuerySchema>): Promise<PackagesOverview> {
    return this.packages.outdated(this.cwdOf(query.cwd));
  }

  @Get('search')
  @ApiOperation({ summary: 'Search for packages', description: 'Searches the npm registry for packages with the `pi-package` keyword and lists the two packages that ship with pi-kit. Cached for five minutes; a registry that does not answer in eight seconds leaves only the pi-kit packages and says why.' })
  @Responds(PackageSearchResponseSchema)
  search(@Query({ schema: PackageSearchQuerySchema.extend(CwdQuerySchema.shape) }) query: z.infer<typeof PackageSearchQuerySchema> & z.infer<typeof CwdQuerySchema>): Promise<PackageSearchResponse> {
    return this.packages.search(query.q ?? '', query.kind, this.cwdOf(query.cwd));
  }

  @Get('detail')
  @ApiOperation({ summary: 'Show a package before installing it', description: 'Returns what the wizard’s second step shows for a source: name, version, what it adds when that can be known, the README as text, and the exact command that will run.' })
  @Responds(PackageDetailSchema)
  @Fails({ 400: 'The folder is not a pi package.' })
  detail(@Query({ schema: PackageDetailQuerySchema }) query: z.infer<typeof PackageDetailQuerySchema>): Promise<PackageDetail> {
    return this.packages.detail(query.source, this.cwdOf(query.cwd));
  }

  @Post(':id/update')
  @HttpCode(200)
  @ApiOperation({ summary: 'Update a package', description: "Updates one package through pi's package manager and reloads the idle open threads." })
  @ApiParam(PACKAGE_ID)
  @Responds(PackageActionResultSchema)
  @Fails({ 400: 'pi could not update it.', 404: NO_PACKAGE })
  update(@Param('id') id: string, @Query({ schema: CwdQuerySchema }) query: z.infer<typeof CwdQuerySchema>): Promise<PackageActionResult> {
    return this.packages.update(this.cwdOf(query.cwd), id);
  }

  @Post(':id/enabled')
  @HttpCode(200)
  @ApiOperation({ summary: 'Turn a package on or off', description: 'Off keeps the package installed and loads nothing from it (every resource kind filtered to none in pi’s settings); open threads read it at their next Reload.' })
  @ApiParam(PACKAGE_ID)
  @Responds(PackagesOverviewSchema)
  @Fails({ 404: NO_PACKAGE })
  enabled(@Param('id') id: string, @Query({ schema: CwdQuerySchema }) query: z.infer<typeof CwdQuerySchema>, @Body({ schema: PackageEnabledRequestSchema }) body: z.infer<typeof PackageEnabledRequestSchema>): Promise<PackagesOverview> {
    return this.packages.setEnabled(this.cwdOf(query.cwd), id, body.enabled);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove a package', description: "Removes one package through pi's package manager (`pi remove`) and reloads the idle open threads." })
  @ApiParam(PACKAGE_ID)
  @Responds(PackageActionResultSchema)
  @Fails({ 400: 'pi could not remove it.', 404: NO_PACKAGE })
  remove(@Param('id') id: string, @Query({ schema: CwdQuerySchema }) query: z.infer<typeof CwdQuerySchema>): Promise<PackageActionResult> {
    return this.packages.remove(this.cwdOf(query.cwd), id);
  }
}
