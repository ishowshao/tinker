import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../src/model/model-request-preflight";
import type { I4ActiveRecallReport } from "./bench-i4-active-recall";
import {
  ACTIVE_RECALL_QUALIFICATION_POLICY_V1,
  ACTIVE_RECALL_QUALIFICATION_POLICY_SHA256,
  evaluateActiveRecallQualification,
} from "./i4-active-recall-policy";

export async function qualifyI4ActiveRecall(input: {
  positiveReportPath: string;
  negativeReportPath: string;
  outputPath: string;
}) {
  const positive = await readReport(input.positiveReportPath);
  const negative = await readReport(input.negativeReportPath);
  const result = evaluateActiveRecallQualification(positive.report, negative.report);
  const qualification = Object.freeze({
    // v2 reports evaluation only; product automation is configured independently.
    schemaVersion: "active-recall-qualification-v2",
    qualificationId: "deepseek-v4-flash-floor-v1",
    qualifiedAt: new Date().toISOString(),
    profile: positive.report.profile,
    requestedModel: positive.report.model,
    resolvedModels: result.resolvedModels,
    manifestVersion: positive.report.manifestVersion,
    manifestSha256: positive.report.manifestHash,
    graderVersion: positive.report.graderVersion,
    fixtureVersion: positive.report.fixture.version,
    recallContractSha256: positive.report.recallContractSha256,
    recallToolDefinitionSha256: positive.report.recallToolDefinitionSha256,
    policy: ACTIVE_RECALL_QUALIFICATION_POLICY_V1,
    policySha256: ACTIVE_RECALL_QUALIFICATION_POLICY_SHA256,
    positiveReportSha256: positive.sha256,
    negativeReportSha256: negative.sha256,
    gates: result.gates,
    metrics: result.metrics,
    passed: result.passed,
  });
  await writeJsonAtomic(input.outputPath, qualification);
  return qualification;
}

async function readReport(reportPath: string): Promise<{
  report: I4ActiveRecallReport;
  sha256: string;
}> {
  const raw = await readFile(reportPath, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Invalid I4 report JSON at ${reportPath}.`, { cause: error });
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== "active-recall-report-v1" ||
    !Array.isArray(value.trials) ||
    !isRecord(value.run) ||
    !isRecord(value.fixture)
  ) {
    throw new Error(`Invalid I4 report schema at ${reportPath}.`);
  }
  return { report: value as I4ActiveRecallReport, sha256: sha256(raw) };
}

async function writeJsonAtomic(outputPath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  const [positiveReportPath, negativeReportPath, outputPath] = Bun.argv.slice(2);
  if (
    positiveReportPath === undefined ||
    negativeReportPath === undefined ||
    outputPath === undefined
  ) {
    throw new Error(
      "Usage: qualify-i4-active-recall <positive-report> <negative-report> <output>",
    );
  }
  const qualification = await qualifyI4ActiveRecall({
    positiveReportPath: path.resolve(positiveReportPath),
    negativeReportPath: path.resolve(negativeReportPath),
    outputPath: path.resolve(outputPath),
  });
  console.log(
    JSON.stringify(
      {
        outputPath: path.resolve(outputPath),
        passed: qualification.passed,
        metrics: qualification.metrics,
      },
      null,
      2,
    ),
  );
}
