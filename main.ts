// Anvil Forge entry point: start the forge, register with the trial env,
// serve until the env reports the suite is done, then exit.
import { runForge } from './app.ts';

await runForge();
