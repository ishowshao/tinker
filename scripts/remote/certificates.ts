import { mkdir, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { isIP } from "node:net";

export async function command(args: string[], cwd?: string): Promise<string> {
  const process = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exit !== 0) throw new Error(`${args[0]} exited ${exit}: ${stderr.trim()}`);
  return stdout.trim();
}

export async function createRemoteCertificates(
  directory: string,
  hosts: string[],
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const altNames = [...new Set(["localhost", "127.0.0.1", ...hosts])]
    .map((host) => {
      if (!isIP(host) && !/^[a-zA-Z0-9.-]+$/.test(host))
        throw new Error("Invalid certificate hostname.");
      return `${isIP(host) ? "IP" : "DNS"}:${host}`;
    })
    .join(",");
  await command([
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-days",
    "365",
    "-subj",
    "/CN=Tinker local development CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-keyout",
    path.join(directory, "ca.key"),
    "-out",
    path.join(directory, "ca.crt"),
  ]);
  for (const name of ["app", "frps", "frpc"]) {
    const ext = path.join(directory, `${name}.ext`);
    await writeFile(
      ext,
      `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=${name === "frpc" ? "clientAuth" : "serverAuth"}\nsubjectAltName=${altNames}\n`,
      { mode: 0o600 },
    );
    await command([
      "openssl",
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-subj",
      `/CN=tinker-${name}`,
      "-keyout",
      path.join(directory, `${name}.key`),
      "-out",
      path.join(directory, `${name}.csr`),
    ]);
    await command([
      "openssl",
      "x509",
      "-req",
      "-days",
      "90",
      "-sha256",
      "-in",
      path.join(directory, `${name}.csr`),
      "-CA",
      path.join(directory, "ca.crt"),
      "-CAkey",
      path.join(directory, "ca.key"),
      "-CAcreateserial",
      "-extfile",
      ext,
      "-out",
      path.join(directory, `${name}.crt`),
    ]);
    await chmod(path.join(directory, `${name}.key`), 0o600);
  }
  await chmod(path.join(directory, "ca.key"), 0o600);
}
