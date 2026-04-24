#!/usr/bin/env node
import { buildProgram } from '../program.js';

buildProgram()
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
