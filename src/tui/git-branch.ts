export async function readCurrentGitBranch(
  workspaceRoot: string,
): Promise<string | undefined> {
  try {
    const subprocess = Bun.spawn(
      ["git", "-C", workspaceRoot, "symbolic-ref", "--quiet", "--short", "HEAD"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const [exitCode, stdout] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
    ]);

    if (exitCode !== 0) {
      return undefined;
    }

    const branch = stdout.trim();
    return branch === "" ? undefined : branch;
  } catch {
    return undefined;
  }
}
