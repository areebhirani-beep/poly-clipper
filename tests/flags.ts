// Reads "--name=value" or "--name value" the way clap (the Poly CLI's parser)
// does, and like clap refuses a separate value that starts with "-". Shared by
// the unit-test fake and the end-to-end mock server.
export function flagValues(args: string[], name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a.startsWith(`${name}=`)) out.push(a.slice(name.length + 1));
    else if (a === name) {
      if (args[i + 1]?.startsWith("-")) throw new Error(`error: a value is required for '${name}'`);
      out.push(args[i + 1]);
    }
  });
  return out;
}
