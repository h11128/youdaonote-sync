#!/usr/bin/env node
import { loadSyncEnv } from './util/load-env.js';
import { createCli } from './cli/cli.js';

loadSyncEnv();
createCli().parse();
