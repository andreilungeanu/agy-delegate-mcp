// Prints the argv it received, so a test can see what cmd.exe handed the launcher.
process.stdout.write(JSON.stringify(process.argv.slice(2)));
