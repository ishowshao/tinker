import { describe, expect, test } from "bun:test";
import { classifyBashRisk } from "../tools/bash-guard";

describe("classifyBashRisk", () => {
  test("matches the v1 high-confidence destructive command set", () => {
    const workspaceRoot = "/Users/example/workspace";
    for (const command of [
      "rm -rf /",
      "rm -fr '/*'",
      'sudo rm -r -f "$HOME"',
      "rm --force --recursive /Users/example/workspace",
      "dd if=/dev/zero of=/dev/disk4",
      "mkfs.ext4 /dev/sda",
      "sudo wipefs -a /dev/disk4",
      ":(){ :|:& };:",
      "shutdown -h now",
      "sudo reboot",
      "halt",
      "poweroff",
      "chmod -R 777 /",
      "chown -R root:wheel /",
    ]) {
      expect(classifyBashRisk(command, { workspaceRoot }), command).toMatchObject({
        dangerous: true,
      });
    }
  });

  test("allows nearby commands whose intent is not deterministically destructive", () => {
    const workspaceRoot = "/Users/example/workspace";
    for (const command of [
      "",
      "   ",
      "rm -rf ./node_modules",
      "rm -rf /tmp/tinker-test",
      "rm -r /",
      "dd if=/dev/zero of=./disk.img",
      "echo shutdown",
      "printf '%s' reboot",
      "git reset --hard",
      "git clean -fd",
      "chmod -R 755 ./build",
      "rm -rf /Users/example/workspace-copy",
    ]) {
      expect(classifyBashRisk(command, { workspaceRoot }), command).toEqual({
        dangerous: false,
      });
    }
  });
});
