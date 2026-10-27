// What a verification report says, as a sentence and a level for `ctx.ui.notify`. Plain ESM, no dependencies: the report is the `verification` of the
// `pi-kit:learn:verified` reply (doc/docs/plugins.md), a JSON object with `state` ('done' | 'stopped' | 'error' | ...), `result` ('pass' | 'partial' | 'failed'), a `summary`
// sentence with the numbers, `warnings` and `error`.

/**
 * @param {Record<string, unknown> | null | undefined} verification the reply's `verification`
 * @param {string} name the draft's name
 * @returns {{ text: string, level: 'info' | 'warning' | 'error' }}
 */
export function describeVerification(verification, name) {
  const v = verification ?? null;
  if (!v) return { text: `No verification of ${name} has been run yet. Run /learn verify.`, level: 'info' };
  const warnings = Array.isArray(v.warnings) ? v.warnings.filter((w) => typeof w === 'string') : [];
  const extra = warnings.length > 0 ? ` ${warnings.join(' ')}` : '';
  switch (v.state) {
    case 'done': {
      const summary = typeof v.summary === 'string' ? v.summary : '';
      const next = ' Read the report in the review dialog, then approve or discard the draft.';
      if (v.result === 'pass') return { text: `${name}: pass. ${summary}${next}${extra}`.replace(/\s+/g, ' ').trim(), level: 'info' };
      if (v.result === 'partial') return { text: `${name}: partial. ${summary}${next}${extra}`.replace(/\s+/g, ' ').trim(), level: 'warning' };
      return { text: `${name}: failed. ${summary} Edit the skill and verify again, or discard it.${extra}`.replace(/\s+/g, ' ').trim(), level: 'warning' };
    }
    case 'stopped':
      return { text: `The verification of ${name} was stopped before it finished. Nothing was compared.`, level: 'info' };
    case 'error':
      return { text: `${name} could not be verified: ${typeof v.error === 'string' ? v.error : 'pi-kit reported an error.'}`, level: 'error' };
    case 'running':
      return { text: `${name} is being verified. Watch the thread “Verify: ${name}” in the sidebar.`, level: 'info' };
    default:
      return { text: `${name} has not been verified.`, level: 'info' };
  }
}
