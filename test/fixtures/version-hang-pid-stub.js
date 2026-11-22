#!/usr/bin/env node
// Writes its pid to $AGY_TEST_PIDFILE, then never answers --version: doctor's probe must end it.
import { writeFileSync } from "node:fs";
if (process.env.AGY_TEST_PIDFILE) writeFileSync(process.env.AGY_TEST_PIDFILE, `${process.pid}\n`);
setInterval(() => {}, 1000);
