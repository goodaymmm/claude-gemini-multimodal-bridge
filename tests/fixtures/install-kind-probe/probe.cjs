/**
 * Prints the lifecycle variables npm sets, as one JSON line on stdout.
 *
 * The point is that the test does not get to decide what npm passes. An earlier
 * test set INIT_CWD to the directory it wanted and asserted the code used it,
 * which proved only that the code read the variable the test had written --
 * and missed both that `--location=global` leaves npm_config_global unset and
 * that INIT_CWD is the invoking directory rather than the project root.
 */

console.log(`CGMB_PROBE ${JSON.stringify({
  npm_config_global: process.env.npm_config_global,
  npm_config_location: process.env.npm_config_location,
  npm_config_local_prefix: process.env.npm_config_local_prefix,
  INIT_CWD: process.env.INIT_CWD,
  cwd: process.cwd(),
})}`);
