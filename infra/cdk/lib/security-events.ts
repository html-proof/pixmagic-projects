import * as events from "aws-cdk-lib/aws-events";

/**
 * Account changes worth an email the moment they happen, as EventBridge reads them from CloudTrail
 * (free: AWS's own events on the default bus). They take the place of GuardDuty's RDS protection
 * (off since 2026-11: docs/aws-deployment.md, "Security events") and answer the security audit's
 * "CloudTrail not alarmed" (docs/security/SECURITY_AUDIT_2026-10-23.md, L18).
 *
 * Each is a call someone made, allowed or refused, so a deploy that changes the same thing sends
 * the email too: the message says who made the call.
 *
 * IAM is a global service and the root user signs in through us-east-1, so those two reach
 * EventBridge there only. The Edge stack (us-east-1) passes them on to the app's Region
 * (edge-stack.ts), where the App stack's rules email all five (app-stack.ts).
 */
const apiCall = (service: string, eventName: string[]): events.EventPattern => ({
  source: [`aws.${service}`],
  detailType: ["AWS API Call via CloudTrail"],
  detail: { eventSource: [`${service}.amazonaws.com`], eventName },
});

/** A database, snapshot, backup or parameter group deleted or changed; a snapshot shared (ModifyDBSnapshotAttribute). */
export const DATABASE_CHANGES = apiCall("rds", events.Match.anyOf(events.Match.prefix("Delete"), events.Match.prefix("Modify")));

/** A new way in to PostgreSQL: a rule added to the database's security group. */
export const databaseNetworkChanges = (dbSecurityGroupId: string): events.EventPattern => {
  const pattern = apiCall("ec2", ["AuthorizeSecurityGroupIngress"]);
  return { ...pattern, detail: { ...pattern.detail, requestParameters: { groupId: [dbSecurityGroupId] } } };
};

/** The account's audit trail stopped, deleted or pointed somewhere else. */
export const TRAIL_CHANGES = apiCall("cloudtrail", ["StopLogging", "DeleteTrail", "UpdateTrail"]);

/** A new IAM user or access key (the account has none: the functions and the deploy use roles), or a managed policy attached to a user, group or role. */
export const IAM_CHANGES = apiCall("iam", events.Match.anyOf(["CreateUser", "CreateAccessKey"], events.Match.prefix("Attach")));

/** The root user signing in to the console, successfully or not. */
export const ROOT_SIGN_IN: events.EventPattern = {
  source: ["aws.signin"],
  detailType: ["AWS Console Sign In via CloudTrail"],
  detail: { eventName: ["ConsoleLogin"], userIdentity: { type: ["Root"] } },
};

/** The two that happen in us-east-1 whatever Region the app is in. */
export const GLOBAL_SECURITY_EVENTS = { Iam: IAM_CHANGES, RootSignIn: ROOT_SIGN_IN } as const;

/** The email's text: what was called, by whom, from where, and whether AWS refused it. */
export function securityEventMessage(): events.RuleTargetInput {
  const field = (path: string) => events.EventField.fromPath(path);
  return events.RuleTargetInput.fromText(
    [
      "bizinsights: a security-relevant change in the AWS account.",
      "",
      `What:  ${field("$.detail.eventName")} (${field("$.detail.eventSource")})`,
      `Who:   ${field("$.detail.userIdentity.arn")}`,
      `From:  ${field("$.detail.sourceIPAddress")}`,
      `When:  ${field("$.detail.eventTime")} in ${field("$.detail.awsRegion")}`,
      `Error: ${field("$.detail.errorCode")} (empty: AWS carried it out)`,
      "",
      "If you or a deploy did this just now, there is nothing to do.",
      "If not: docs/aws-deployment.md, Security events.",
    ].join("\n"),
  );
}
