import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MIGRATE_BEFORE_LIVE_CODE, MIGRATE_BEFORE_LIVE_FAILED } from "../lib/migrate-before-live.js";

/**
 * "Deploy (CDK)" in aws-deploy.yml runs cdk deploy again when the failed run's output matches
 * `network` (grep -E): a connection to AWS dropped, which the PC's runner on a phone hotspot sees
 * often. Any other failure must not match, so the rollback runs at once.
 */
const workflow = readFileSync(new URL("../../../.github/workflows/aws-deploy.yml", import.meta.url), "utf8");
const pattern = /^\s*network='([^']+)'\s*$/m.exec(workflow)?.[1];
// grep -E and JavaScript read an alternation of plain words the same way.
const network = new RegExp(pattern ?? "(?!)");
const matches = (output: string) => output.split(/\r?\n/).some((line) => network.test(line));
// A migration that failed in AWS (the App stack's gate) is checked first and never run again.
const guard = /grep -q "([^"]+)" "\$log"/.exec(workflow)?.[1];
const retried = (output: string) => !(guard && output.includes(guard)) && matches(output);

/** What the failed Deploy to AWS runs printed, word for word (their CI timestamps cut off). */
const FAILED = {
  // 39322254585, 2026-10-19: the API's code to S3.
  "the API's code to S3": [
    "InsightsApp-production: success: Published SiteFiles/Asset1 (605411278365-ap-southeast-2-1586ad38)",
    "InsightsApp-production: fail: @smithy/node-http-handler - the request socket did not establish a connection with the server within the configured timeout of 10000 ms.",
    "Failed to publish asset Fn-api/Code (605411278365-ap-southeast-2-d35d3108)",
    "‣ AggregateError: ",
  ],
  // 40002955822 attempt 1, 2026-10-23: no network error printed, only the roles it couldn't assume.
  "roles it couldn't assume": [
    "current credentials could not be used to assume 'arn:aws:iam::605411278365:role/cdk-hnb659fds-file-publishing-role-605411278365-us-east-1', but are for the right account. Proceeding anyway.",
    "InsightsEdge-production: This CDK deployment requires bootstrap stack version '6', but during the confirmation via SSM parameter /cdk-bootstrap/hnb659fds/version the following error occurred: AccessDeniedException: User: arn:aws:sts::605411278365:assumed-role/insights-production-github-deploy/GitHubActions is not authorized to perform: ssm:GetParameter",
    "‣ BootstrapVersionSsmConfirmationFailed: This CDK deployment requires bootstrap stack version '6'",
  ],
  // 40002955822 attempt 2, 2026-10-23: both.
  both: [
    "current credentials could not be used to assume 'arn:aws:iam::605411278365:role/cdk-hnb659fds-file-publishing-role-605411278365-ap-southeast-2', but are for the right account. Proceeding anyway.",
    "InsightsCi-production: fail: Bucket named 'cdk-hnb659fds-assets-605411278365-ap-southeast-2' exists, but we dont have access to it.",
    "InsightsEdge-production: fail: @smithy/node-http-handler - the request socket did not establish a connection with the server within the configured timeout of 10000 ms.",
    "Failed to publish asset AWS679f53fac002430cb0da5b7982bd2287/Code (605411278365-us-east-1-de9cee2d)",
  ],
  // The account lookup (STS, the CLI's first call) cut off: aws-cdk 2.1143.0 run against a stand-in
  // AWS whose connections were black-holed for 25 s (its account here production's). All it prints
  // after the synthesis.
  "the account lookup": ["✨  Synthesis time: 20.73s", "", "Need to perform AWS calls for account 605411278365, but no credentials have been configured"],
};

describe("what Deploy (CDK) runs again", () => {
  it("reads the pattern from the step", () => {
    expect(pattern).toBeTruthy();
  });

  it.each(Object.entries(FAILED))("is a run that failed on %s", (_, lines) => {
    expect(matches(lines.join("\n"))).toBe(true);
  });

  it("is Node's socket and DNS errors", () => {
    for (const line of ["getaddrinfo ENOTFOUND sts.ap-southeast-2.amazonaws.com", "getaddrinfo EAI_AGAIN s3.us-east-1.amazonaws.com", "read ECONNRESET", "connect ETIMEDOUT 64:ff9b::31b:b173:443", "socket hang up"]) {
      expect(matches(line), line).toBe(true);
    }
  });

  it("is not a deploy that failed for a reason of its own", () => {
    for (const output of [
      "❌  InsightsApp-production failed: ToolkitError: The stack named InsightsApp-production failed to deploy: UPDATE_ROLLBACK_COMPLETE: Resource handler returned message: \"Invalid request provided: The runtime parameter of nodejs99.x is no longer supported\"",
      "InsightsApp-production | UPDATE_FAILED | Custom::CDKBucketDeployment | SiteFiles/CustomResource Default | Resource timed out waiting for completion",
      "Failed to build asset Fn-api/Code",
      "InsightsApp-production: fail: ENOENT: no such file or directory, open 'apps/aws/dist/function/index.mjs'",
      "Failed to publish asset Fn-api/Code (605411278365-ap-southeast-2-d35d3108)\n‣ AggregateError: ",
      "AccessDenied: User: arn:aws:sts::605411278365:assumed-role/cdk-hnb659fds-cfn-exec-role-605411278365-ap-southeast-2/AWSCloudFormation is not authorized to perform: iam:CreateRole",
      // Printed on every deploy.
      "[Warning] Template validation found issues in your templates (reported as warnings).\nWARNING Conditions/HasGoogle: Fn::Equals in condition 'HasGoogle' will always return False (CloudFormation Validate)",
    ]) {
      expect(matches(output), output).toBe(false);
    }
  });
});

describe("what Deploy (CDK) never runs again", () => {
  it("reads the gate's words from the step, the same the handler fails with", () => {
    expect(guard).toBe(MIGRATE_BEFORE_LIVE_FAILED);
    expect(MIGRATE_BEFORE_LIVE_CODE).toContain(MIGRATE_BEFORE_LIVE_FAILED);
  });

  it("is a migration that failed in AWS, even when its error reads like the network", () => {
    const output = [
      "InsightsApp-production | 12/17 | 11:43:05 am | UPDATE_FAILED        | Custom::MigrateBeforeLive | MigrateBeforeLive/Default (MigrateBeforeLive) Received response status [FAILED] from custom resource. Message returned: migrate-before-live failed (nothing moved to the new release): {\"errorMessage\":\"connect ETIMEDOUT 10.0.3.12:5432\"}",
      "❌  InsightsApp-production failed: ToolkitError: The stack named InsightsApp-production failed to deploy: UPDATE_ROLLBACK_COMPLETE",
    ].join("\n");
    expect(matches(output)).toBe(true);
    expect(retried(output)).toBe(false);
  });

  it("still runs again every run that failed on the network", () => {
    for (const lines of Object.values(FAILED)) expect(retried(lines.join("\n"))).toBe(true);
  });

  it("is not the gate timing out (a failure of its own: the rollback runs at once)", () => {
    expect(retried("Received response status [FAILED] from custom resource. Message returned: Task timed out after 840.00 seconds")).toBe(false);
  });
});
