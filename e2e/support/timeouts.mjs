// The one time limit of the end-to-end tests: how long any wait for the page (an element, a response, a navigation) may take before
// the test fails and names what it waited for. Generous, because a local model can take minutes; E2E_TIMEOUT=<ms> changes it and
// E2E_TIMEOUT=0 removes it (a test that waits for what never comes then has to be stopped by hand).
export const WAIT_MS = process.env.E2E_TIMEOUT === undefined ? 300_000 : Number(process.env.E2E_TIMEOUT) || 0;
