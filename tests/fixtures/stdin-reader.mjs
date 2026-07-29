// Test fixture: stands in for `agy models`.
//
// Reads stdin to EOF before writing anything, which is exactly what agy does.
// A caller that leaves stdin as an open pipe never sees output and hangs until
// its own timeout -- the regression this fixture exists to catch.
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', () => {
  process.stdout.write(`STDIN_CLOSED bytes=${data.length}\n`);
  process.exit(0);
});
