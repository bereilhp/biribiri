#!/usr/bin/env node

import { main } from '../src/index.js';

main().catch((error) => {
  console.error(`biribiri: ${error.message}`);
  process.exitCode = 1;
});
