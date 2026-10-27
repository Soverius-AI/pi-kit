import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Rewrites a file of the scratch project (a change pi did not make, for the review and screenshot scenes). */
export function editProjectFile(project, relative, transform) {
  const path = join(project, relative);
  writeFileSync(path, transform(readFileSync(path, 'utf8')));
}
