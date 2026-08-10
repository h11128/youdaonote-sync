#!/usr/bin/env node
import { loadSyncEnv } from './util/load-env.js';
import { createCli } from './cli/cli.js';

loadSyncEnv();
// parseAsync so commander waits on async actions (sync / diagnose cache exitCodes).
void createCli().parseAsync(process.argv);
