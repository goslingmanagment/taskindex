#!/usr/bin/env node
import { runAdmin } from './admin-run.js';

process.exitCode = await runAdmin(process.argv.slice(2));
