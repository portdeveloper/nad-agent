/** Flush the smoke success marker before forcing the one-shot process to exit. */
export function flushSmokeSuccess(
  write = process.stdout.write.bind(process.stdout),
  exit = process.exit,
) {
  return new Promise((resolve, reject) => {
    write("\nSMOKE_OK\n", (err) => {
      if (err) {
        reject(err);
        return;
      }
      exit(0);
      resolve();
    });
  });
}
