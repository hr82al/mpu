#!/usr/bin/env node
import { buildProgram } from '../program.js';

buildProgram()
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    if (err instanceof Error) {
      console.error(err.message);
      if (process.env.MPU_DEBUG) console.error(err.stack);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
