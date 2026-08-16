export async function readPassphrase(prompt = "Vault passphrase: "): Promise<string> {
  const fromEnvironment = process.env.TRAJPACK_PASSPHRASE;
  if (fromEnvironment) {
    // A CLI invocation needs the environment value once. Remove the inherited
    // reference immediately so later host/tool subprocesses cannot receive it
    // and the process does not retain two long-lived copies.
    delete process.env.TRAJPACK_PASSPHRASE;
    return fromEnvironment;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Set TRAJPACK_PASSPHRASE for non-interactive use");
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Passphrase entry cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          if (value.length < 12) reject(new Error("Vault passphrase must contain at least 12 characters"));
          else resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}
