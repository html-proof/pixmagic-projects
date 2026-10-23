import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";

// A stand-in Lambda package, so the stacks synthesize without building the real one.
const fnDir = mkdtempSync(join(tmpdir(), "insights-fn-"));
writeFileSync(join(fnDir, "index.mjs"), "export const handler = async () => ({});\n");
writeFileSync(join(fnDir, "cognito-email.mjs"), "export const handler = async () => ({});\n");
mkdirSync(join(fnDir, "public/_next/static/chunks"), { recursive: true });
writeFileSync(join(fnDir, "public/_next/static/chunks/main.js"), "void 0;\n");
mkdirSync(join(fnDir, "fallback"));
writeFileSync(join(fnDir, "fallback/unavailable.html"), "<!doctype html><title>unavailable</title>\n");
writeFileSync(join(fnDir, "build.json"), `${JSON.stringify({ commit: "0123456789abcdef0123456789abcdef01234567", builtAt: "2026-10-17T09:00:00.000Z" })}\n`);
process.env.INSIGHTS_FUNCTION_DIR = fnDir;

const { envConfig, appVars, REPO_ROOT } = await import("../lib/config.js");
const { EdgeStack } = await import("../lib/edge-stack.js");
const { DataStack } = await import("../lib/data-stack.js");
const { AppStack } = await import("../lib/app-stack.js");
const { AuthStack } = await import("../lib/auth-stack.js");
const { CiStack } = await import("../lib/ci-stack.js");
const { AuditStack, ACCOUNT_REGIONS, ANALYZER_NAME } = await import("../lib/audit-stack.js");
const { viewerRequestCode } = await import("../lib/viewer-request.js");
const { API_PATH_PATTERNS } = await import("../../../apps/aws/src/paths.js");

function synth(context: Record<string, string> = {}) {
  const app = new App({ context });
  const cfg = envConfig((k) => app.node.tryGetContext(k));
  const env = { account: cfg.account, region: cfg.region };
  const edge = new EdgeStack(app, "E", cfg, { env: { account: cfg.account, region: "us-east-1" }, crossRegionReferences: true });
  const data = new DataStack(app, "D", cfg, { env });
  const appStack = new AppStack(app, "A", cfg, data, edge.webAclArn, { env, crossRegionReferences: true });
  const auth = new AuthStack(app, "U", cfg, { env, appUrl: appStack.appUrl, apiRole: appStack.apiRole, runtimeParam: appStack.runtimeParam });
  const ci = new CiStack(app, "C", cfg, { env });
  const audit = new AuditStack(app, "T", cfg, { env, accessLogsBucketName: data.accessLogs.bucketName });
  return { edge: Template.fromStack(edge), data: Template.fromStack(data), app: Template.fromStack(appStack), auth: Template.fromStack(auth), ci: Template.fromStack(ci), audit: Template.fromStack(audit) };
}

let t: ReturnType<typeof synth>;
beforeAll(() => {
  t = synth();
});

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
/** The app's distribution and the small one that serves its "temporarily unavailable" page. */
function distributions(app: Template): { main: Json; fallback: Json } {
  const all = Object.values(app.findResources("AWS::CloudFront::Distribution")).map((r) => r.Properties.DistributionConfig);
  expect(all).toHaveLength(2);
  return { main: all.find((d) => !/can't answer/.test(d.Comment)), fallback: all.find((d) => /can't answer/.test(d.Comment)) };
}

describe("the data stack", () => {
  it("keeps the database private, encrypted, backed up and protected, with a standby in the other AZ", () => {
    t.data.hasResourceProperties("AWS::RDS::DBInstance", {
      PubliclyAccessible: false,
      StorageEncrypted: true,
      DeletionProtection: true,
      BackupRetentionPeriod: 14,
      MultiAZ: true,
      DBInstanceClass: "db.t4g.micro",
      Engine: "postgres",
    });
    t.data.hasResource("AWS::RDS::DBInstance", { DeletionPolicy: "Snapshot" });
    // Point-in-time backups outlive the instance.
    t.data.hasResourceProperties("AWS::RDS::DBInstance", { DeleteAutomatedBackups: false });
    // Enhanced Monitoring every minute, through RDS's own role.
    t.data.hasResourceProperties("AWS::RDS::DBInstance", { MonitoringInterval: 60, MonitoringRoleArn: { "Fn::GetAtt": [Match.stringLikeRegexp("^DbMonitoringRole"), "Arn"] } });
    t.data.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: { Statement: [Match.objectLike({ Principal: { Service: "monitoring.rds.amazonaws.com" } })] },
      ManagedPolicyArns: [{ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"]] }],
    });
    t.data.hasResourceProperties("AWS::RDS::DBParameterGroup", { Parameters: Match.objectLike({ "rds.force_ssl": "1", log_parameter_max_length: "0" }) });
  });

  it("lets only the functions and the admin host reach PostgreSQL, and nothing in from the internet", () => {
    const ingress = Object.values(t.data.findResources("AWS::EC2::SecurityGroupIngress"));
    expect(ingress.length).toBeGreaterThan(0);
    for (const r of ingress) {
      expect(r.Properties.FromPort).toBe(5432);
      expect(r.Properties.SourceSecurityGroupId).toBeDefined();
    }
    for (const g of Object.values(t.data.findResources("AWS::EC2::SecurityGroup"))) {
      for (const rule of (g.Properties.SecurityGroupIngress ?? []) as Array<{ CidrIp?: string }>) expect(rule.CidrIp).not.toBe("0.0.0.0/0");
    }
  });

  it("blocks public access to every bucket and requires TLS", () => {
    const buckets = Object.values(t.data.findResources("AWS::S3::Bucket"));
    expect(buckets).toHaveLength(3);
    for (const b of buckets) {
      expect(b.Properties.PublicAccessBlockConfiguration).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
    }
    const policies = Object.values(t.data.findResources("AWS::S3::BucketPolicy"));
    expect(policies).toHaveLength(3);
    for (const p of policies) {
      expect(p.Properties.PolicyDocument.Statement).toEqual(expect.arrayContaining([expect.objectContaining({ Effect: "Deny", Condition: { Bool: { "aws:SecureTransport": "false" } } })]));
    }
  });

  it("versions every bucket and lets old versions expire (Trusted Advisor S3 Bucket Versioning)", () => {
    const buckets = ["data", "app", "audit", "edge"].flatMap((stack) => Object.values(t[stack as keyof typeof t].findResources("AWS::S3::Bucket")));
    expect(buckets).toHaveLength(6);
    for (const b of buckets) {
      expect(b.Properties.VersioningConfiguration).toEqual({ Status: "Enabled" });
      const rules = b.Properties.LifecycleConfiguration.Rules as Array<{ NoncurrentVersionExpiration?: { NoncurrentDays: number } }>;
      expect(rules.some((r) => r.NoncurrentVersionExpiration)).toBe(true);
    }
    // Processed webhook bodies hold customer data: an old version stays one day only.
    t.data.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: Match.stringLikeRegexp("-payloads-"),
      LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ NoncurrentVersionExpiration: { NoncurrentDays: 1 } }), Match.objectLike({ ExpiredObjectDeleteMarker: true })]) },
    });
  });

  it("goes out through a NAT instance in each AZ, not a NAT gateway, and has no SSH key anywhere", () => {
    t.data.resourceCountIs("AWS::EC2::NatGateway", 0);
    t.data.resourceCountIs("AWS::EC2::EIP", 0);
    t.data.allResourcesProperties("AWS::EC2::Instance", { KeyName: Match.absent() });
    const nats = Object.entries(t.data.findResources("AWS::EC2::Instance", { Properties: { SourceDestCheck: false } }));
    expect(nats).toHaveLength(2);
    const azOf = (props: { AvailabilityZone?: string }) => props.AvailabilityZone;
    expect(new Set(nats.map(([, r]) => azOf(r.Properties))).size).toBe(2);
    for (const [, r] of nats) {
      // Routes move to a new instance only once it says NAT is up.
      expect(r.CreationPolicy).toEqual({ ResourceSignal: { Timeout: "PT15M" } });
      expect(JSON.stringify(r.Properties.UserData)).toContain("MASQUERADE");
      expect(JSON.stringify(r.Properties.UserData)).toContain("cfn-signal");
      // dnf is killed for lack of memory on a t4g.nano without swap.
      expect(JSON.stringify(r.Properties.UserData)).toContain("swapon /swapfile");
    }
    // Each private (app) subnet's default route goes to the NAT instance in its own AZ.
    const routes = Object.values(t.data.findResources("AWS::EC2::Route", { Properties: { DestinationCidrBlock: "0.0.0.0/0", InstanceId: Match.anyValue() } }));
    expect(routes).toHaveLength(2);
    const subnets = t.data.findResources("AWS::EC2::Subnet");
    const tables = t.data.findResources("AWS::EC2::SubnetRouteTableAssociation");
    for (const route of routes) {
      const instanceAz = azOf(Object.fromEntries(nats)[route.Properties.InstanceId.Ref]!.Properties);
      const assoc = Object.values(tables).find((a) => a.Properties.RouteTableId.Ref === route.Properties.RouteTableId.Ref)!;
      expect(subnets[assoc.Properties.SubnetId.Ref]!.Properties.AvailabilityZone).toBe(instanceAz);
    }
    // IMDSv2 only, set on the instances: no launch templates, whose names would collide.
    for (const [, r] of nats) expect(r.Properties.MetadataOptions).toEqual({ HttpTokens: "required" });
    const names = Object.values(t.data.findResources("AWS::EC2::LaunchTemplate")).map((lt) => lt.Properties.LaunchTemplateName);
    expect(new Set(names).size).toBe(names.length);
    // EC2 refuses descriptions outside a-zA-Z0-9. _-:/()#,@[]+=&;{}!$* (an apostrophe failed a deploy).
    const ec2Text = /^[a-zA-Z0-9. _\-:/()#,@[\]+=&;{}!$*]*$/;
    for (const g of Object.values(t.data.findResources("AWS::EC2::SecurityGroup"))) {
      expect(g.Properties.GroupDescription).toMatch(ec2Text);
      for (const rule of [...(g.Properties.SecurityGroupIngress ?? []), ...(g.Properties.SecurityGroupEgress ?? [])] as Array<{ Description?: string }>) expect(rule.Description ?? "").toMatch(ec2Text);
    }
    for (const r of Object.values(t.data.findResources("AWS::EC2::SecurityGroupIngress"))) expect(r.Properties.Description ?? "").toMatch(ec2Text);
    // Inbound only from inside the VPC.
    t.data.hasResourceProperties("AWS::EC2::SecurityGroup", {
      GroupName: "insights-production-nat",
      SecurityGroupIngress: [Match.objectLike({ IpProtocol: "-1", CidrIp: { "Fn::GetAtt": [Match.stringLikeRegexp("^Vpc"), "CidrBlock"] } })],
    });
  });

  it("recovers or reboots a failed NAT instance and tells the alarm topic", () => {
    const topic = `arn:aws:sns:ap-southeast-2:605411278365:insights-production-alarms`;
    for (const az of ["a", "b"]) {
      t.data.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: `insights-production-nat-${az}-system-check`,
        MetricName: "StatusCheckFailed_System",
        AlarmActions: [{ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":automate:ap-southeast-2:ec2:recover"]] }, topic],
      });
      t.data.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: `insights-production-nat-${az}-instance-check`,
        MetricName: "StatusCheckFailed_Instance",
        AlarmActions: [{ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":automate:ap-southeast-2:ec2:reboot"]] }, topic],
      });
    }
  });

  it("snapshots every EBS disk daily and keeps a week, a replaced disk's snapshots included", () => {
    t.data.resourceCountIs("AWS::DLM::LifecyclePolicy", 1);
    t.data.hasResourceProperties("AWS::DLM::LifecyclePolicy", {
      DefaultPolicy: "VOLUME",
      State: "ENABLED",
      CreateInterval: 1,
      RetainInterval: 7,
      ExtendDeletion: true,
      PolicyDetails: Match.absent(),
      ExecutionRoleArn: { "Fn::GetAtt": [Match.stringLikeRegexp("^SnapshotRole"), "Arn"] },
      Description: Match.stringLikeRegexp("^[0-9A-Za-z _-]+$"),
    });
    t.data.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: { Statement: [Match.objectLike({ Principal: { Service: "dlm.amazonaws.com" } })] },
      ManagedPolicyArns: [{ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"]] }],
    });
    // One default policy per Region: staging's disks are production's policy's.
    synth({ env: "staging" }).data.resourceCountIs("AWS::DLM::LifecyclePolicy", 0);
  });

  it("snapshots each instance's disk as soon as the instance exists, and deletes only those snapshots", () => {
    // The daily policy waits a day before a new disk's first snapshot; a new image replaces all three.
    const instances = Object.keys(t.data.findResources("AWS::EC2::Instance"));
    expect(instances).toHaveLength(3);
    const launch = Object.values(t.data.findResources("Custom::AWS"));
    expect(launch).toHaveLength(3);
    const instanceOf = (r: (typeof launch)[number]) => JSON.stringify(r.Properties.Create).match(/"Ref":"(\w+)"/)?.[1];
    expect(new Set(launch.map(instanceOf))).toEqual(new Set(instances));
    for (const r of launch) {
      expect(JSON.stringify(r.Properties.Create)).toContain('\\"action\\":\\"createSnapshots\\"');
      // A replaced instance (a new id) gets its own; then the old physical id, its snapshot, is deleted.
      expect(r.Properties.Update).toEqual(r.Properties.Create);
      expect(JSON.stringify(r.Properties.Delete)).toContain('\\"action\\":\\"deleteSnapshot\\"');
    }
    t.data.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: "ec2:DeleteSnapshot", Condition: { StringEquals: { "ec2:ResourceTag/insights-snapshot": "launch" } } })]) },
    });
  });
});

describe("the app stack", () => {
  it("leaves the schedules off unless asked (no double syncs while the old deployment still runs)", () => {
    const states = (tpl: Template) =>
      Object.values(tpl.findResources("AWS::Scheduler::Schedule"))
        .filter((s) => "cron" in JSON.parse(s.Properties.Target.Input))
        .map((s) => s.Properties.State);
    expect(states(t.app)).toEqual(["DISABLED", "DISABLED"]);
    expect(states(synth({ schedules: "on" }).app)).toEqual(["ENABLED", "ENABLED"]);
  });

  it("emails the owner the day's AWS cost every morning, letting only the cron function read Cost Explorer", () => {
    const costSchedules = (tpl: Template) => Object.values(tpl.findResources("AWS::Scheduler::Schedule", { Properties: { Target: { Input: '{"action":"cost-report"}' } } }));
    const ceGrants = (tpl: Template) =>
      // The ce: service prefix itself, not "sms-voice:", which ends in "ce:" too.
      Object.values(tpl.findResources("AWS::IAM::Policy")).filter((p) => JSON.stringify(p.Properties.PolicyDocument).includes('"ce:'));
    // Once a day at 07:00 in Victoria, on even while the sweeps' schedules are off.
    const [report, ...others] = costSchedules(t.app);
    expect(others).toHaveLength(0);
    expect(report!.Properties).toMatchObject({
      Name: "insights-production-costreport",
      ScheduleExpression: "cron(0 7 * * ? *)",
      ScheduleExpressionTimezone: "Australia/Melbourne",
      State: "ENABLED",
      Target: { Arn: { Ref: expect.stringMatching(/^Livecron/) }, DeadLetterConfig: { Arn: { "Fn::GetAtt": [expect.stringMatching(/^MissedTicks/), "Arn"] } } },
    });
    // Exactly ce:GetCostAndUsage (no resource-level permissions exist for it), on the cron role alone.
    const grants = ceGrants(t.app);
    expect(grants).toHaveLength(1);
    const statements = grants[0]!.Properties.PolicyDocument.Statement as Array<{ Action: unknown; Resource: unknown }>;
    expect(statements.filter((st) => [st.Action].flat().some((a) => String(a).startsWith("ce:")))).toEqual([{ Action: "ce:GetCostAndUsage", Effect: "Allow", Resource: "*" }]);
    expect(grants[0]!.Properties.Roles).toEqual([{ Ref: expect.stringMatching(/^FncronServiceRole/) }]);
    // The budget's address, on the cron function only.
    const vars = (name: string) => Object.values(t.app.findResources("AWS::Lambda::Function", { Properties: { FunctionName: name } }))[0]!.Properties.Environment.Variables as Record<string, unknown>;
    expect(vars("insights-production-cron").COST_REPORT_TO).toBe("bizinsightsaus@yahoo.com");
    expect(vars("insights-production-api").COST_REPORT_TO).toBeUndefined();
    expect(vars("insights-production-jobs").COST_REPORT_TO).toBeUndefined();
    // Off in staging (the account's bill is production's email) and with -c costReport=off: no schedule, no grant, no address.
    for (const off of [synth({ env: "staging" }).app, synth({ costReport: "off" }).app]) {
      expect(costSchedules(off)).toHaveLength(0);
      expect(ceGrants(off)).toHaveLength(0);
      for (const f of Object.values(off.findResources("AWS::Lambda::Function"))) expect(f.Properties.Environment?.Variables?.COST_REPORT_TO).toBeUndefined();
    }
  });

  it("gives every job queue a dead-letter queue and covers the jobs timeout", () => {
    const queues = Object.values(t.app.findResources("AWS::SQS::Queue")).filter((q) => q.Properties.RedrivePolicy);
    expect(queues).toHaveLength(5);
    for (const q of queues) {
      expect(q.Properties.RedrivePolicy.maxReceiveCount).toBe(10);
      expect(q.Properties.VisibilityTimeout).toBeGreaterThanOrEqual(900);
    }
    t.app.resourceCountIs("AWS::Lambda::EventSourceMapping", 5);
    t.app.allResourcesProperties("AWS::Lambda::EventSourceMapping", { FunctionResponseTypes: ["ReportBatchItemFailures"] });
  });

  it("routes SMS delivery events from the configuration set to the jobs function, publishable only by this account's SMS service", () => {
    t.app.hasResourceProperties("AWS::SMSVOICE::ConfigurationSet", {
      ConfigurationSetName: "insights-production-sms",
      EventDestinations: [Match.objectLike({ Enabled: true, MatchingEventTypes: ["TEXT_ALL"], SnsDestination: { TopicArn: { Ref: Match.stringLikeRegexp("^SmsEvents") } } })],
    });
    t.app.hasResourceProperties("AWS::SNS::TopicPolicy", {
      Topics: [{ Ref: Match.stringLikeRegexp("^SmsEvents") }],
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: "sns:Publish", Principal: { Service: "sms-voice.amazonaws.com" }, Condition: { StringEquals: { "aws:SourceAccount": Match.anyValue() } } })]) },
    });
    t.app.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "sqs", RawMessageDelivery: true, Endpoint: { "Fn::GetAtt": [Match.stringLikeRegexp("^QueuesmsEvents"), "Arn"] } });
    t.app.hasResourceProperties("AWS::Lambda::EventSourceMapping", { EventSourceArn: { "Fn::GetAtt": [Match.stringLikeRegexp("^QueuesmsEvents"), "Arn"] }, FunctionResponseTypes: ["ReportBatchItemFailures"] });
    const vars = (name: string) => Object.values(t.app.findResources("AWS::Lambda::Function", { Properties: { FunctionName: name } }))[0]!.Properties.Environment.Variables as Record<string, unknown>;
    expect(vars("insights-production-jobs").SMS_CONFIGURATION_SET).toBe("insights-production-sms");
  });

  it("gives each function only the SMS calls it makes, and sending only on this account's own SMS resources", () => {
    const policies = Object.values(t.app.findResources("AWS::IAM::Policy"));
    const statementsOf = (role: RegExp) =>
      policies.filter((p) => (p.Properties.Roles as Array<{ Ref: string }>).some((r) => role.test(r.Ref))).flatMap((p) => p.Properties.PolicyDocument.Statement as Array<{ Action: string | string[]; Resource: unknown }>);
    const smsActions = (role: RegExp) => statementsOf(role).flatMap((st) => [st.Action].flat()).filter((a) => a.startsWith("sms-voice:"));
    expect(smsActions(/^FnjobsServiceRole/)).toEqual(["sms-voice:SendTextMessage"]);
    expect(smsActions(/^FncronServiceRole/)).toContain("sms-voice:DescribeOptedOutNumbers");
    expect(smsActions(/^FncronServiceRole/)).not.toContain("sms-voice:SendTextMessage");
    expect(smsActions(/^FnapiServiceRole/)).toEqual(expect.arrayContaining(["sms-voice:SendTextMessage", "sms-voice:CreateVerifiedDestinationNumber", "sms-voice:DescribeSenderIds", "sms-voice:ListTagsForResource"]));
    for (const st of statementsOf(/ServiceRole/)) {
      if ([st.Action].flat().includes("sms-voice:SendTextMessage")) {
        for (const r of [st.Resource].flat()) expect(JSON.stringify(r)).toMatch(/arn:aws:sms-voice:\*:\d+:(configuration-set|phone-number|sender-id|pool|protect-configuration)\/\*/);
      }
    }
  });

  it("parks a scheduled run that never ran, instead of dropping it", () => {
    const missed = { "Fn::GetAtt": [Match.stringLikeRegexp("^MissedTicks"), "Arn"] };
    t.app.allResourcesProperties("AWS::Scheduler::Schedule", { Target: Match.objectLike({ DeadLetterConfig: { Arn: missed } }) });
    // Under the 15 minutes between ticks: a late hand-over never runs on top of the next one.
    for (const s of Object.values(t.app.findResources("AWS::Scheduler::Schedule"))) expect(s.Properties.Target.RetryPolicy.MaximumEventAgeInSeconds).toBeLessThan(900);
    t.app.hasResourceProperties("AWS::Lambda::EventInvokeConfig", {
      Qualifier: Match.anyValue(), // the `live` alias, by reference
      MaximumEventAgeInSeconds: 900,
      MaximumRetryAttempts: 2,
      DestinationConfig: { OnFailure: { Destination: missed } },
    });
    t.app.hasResourceProperties("AWS::CloudWatch::Alarm", { AlarmName: "insights-production-cron-missed-ticks" });
  });

  it("tells the alarm topic about the database's events", () => {
    t.app.hasResourceProperties("AWS::RDS::EventSubscription", {
      SourceType: "db-instance",
      SnsTopicArn: { Ref: Match.stringLikeRegexp("^Alarms") },
      EventCategories: Match.arrayWith(["availability", "failure", "low storage"]),
    });
    // Sized for the instance class: 75% of a t4g.micro's ~80 connections.
    t.app.hasResourceProperties("AWS::CloudWatch::Alarm", { AlarmName: "insights-production-db-connections", Threshold: 60 });
    t.app.hasResourceProperties("AWS::SNS::TopicPolicy", {
      PolicyDocument: { Statement: [Match.objectLike({ Action: "sns:Publish", Principal: { Service: ["cloudwatch.amazonaws.com", "events.rds.amazonaws.com"] } })] },
    });
  });

  it("emails the owner as the month's spend passes 50/75/90/100% of US$80, and on a forecast above it", () => {
    const [budget] = Object.values(t.app.findResources("AWS::Budgets::Budget"));
    expect(budget!.Properties.Budget).toMatchObject({ BudgetType: "COST", TimeUnit: "MONTHLY", BudgetLimit: { Amount: 80, Unit: "USD" } });
    const alerts = budget!.Properties.NotificationsWithSubscribers as Array<{ Notification: Record<string, unknown>; Subscribers: unknown[] }>;
    expect(alerts.map((a) => [a.Notification.NotificationType, a.Notification.Threshold])).toEqual([["ACTUAL", 50], ["ACTUAL", 75], ["ACTUAL", 90], ["ACTUAL", 100], ["FORECASTED", 100]]);
    for (const a of alerts) expect(a.Subscribers).toEqual([{ SubscriptionType: "EMAIL", Address: "bizinsightsaus@yahoo.com" }]);
    // The alarms stay off email unless alertEmail is given (the one subscription is SMS events → their queue).
    expect(Object.values(t.app.findResources("AWS::SNS::Subscription")).filter((s) => s.Properties.Protocol === "email")).toHaveLength(0);
    // A change to the alerts replaces the budget, so it gets a name of its own.
    const name = budget!.Properties.Budget.BudgetName as string;
    expect(name).toMatch(/^insights-production-monthly-[0-9a-f]{8}$/);
    const other = Object.values(synth({ budgetEmail: "someone@example.com" }).app.findResources("AWS::Budgets::Budget"))[0]!;
    expect(other.Properties.Budget.BudgetName).not.toBe(name);
    // Staging: no address, no alerts, the plain name.
    const staging = Object.values(synth({ env: "staging" }).app.findResources("AWS::Budgets::Budget"))[0]!;
    expect(staging.Properties.Budget).toMatchObject({ BudgetName: "insights-staging-monthly", BudgetLimit: { Amount: 40 } });
    expect(staging.Properties.NotificationsWithSubscribers).toBeUndefined();
  });

  it("tells the functions which commit and build they run (GET /api/version shows it)", () => {
    const fns = Object.values(t.app.findResources("AWS::Lambda::Function", { Properties: { FunctionName: Match.stringLikeRegexp("^insights-production-(api|jobs|cron)$") } }));
    expect(fns).toHaveLength(3);
    for (const f of fns) {
      expect(f.Properties.Environment.Variables).toMatchObject({ APP_COMMIT: "0123456789abcdef0123456789abcdef01234567", APP_BUILT_AT: "2026-10-17T09:00:00.000Z", APP_ENVIRONMENT: "production" });
      expect(f.Properties.Description).toMatch(/\(0123456\)$/);
    }
  });

  it("keeps earlier function versions, so a rollback has something to go back to", () => {
    const versions = Object.values(t.app.findResources("AWS::Lambda::Version"));
    expect(versions).toHaveLength(3);
    for (const v of versions) expect(v.DeletionPolicy).toBe("Retain");
  });

  it("runs the functions in the VPC, with secrets only by reference", () => {
    // The app's three (CDK's own upload helper for the build files is a Python function).
    const fns = Object.values(t.app.findResources("AWS::Lambda::Function")).filter((f) => f.Properties.Handler === "index.handler" && String(f.Properties.Runtime).startsWith("nodejs"));
    expect(fns).toHaveLength(3);
    for (const f of fns) {
      expect(f.Properties.VpcConfig).toBeDefined();
      const vars = f.Properties.Environment.Variables as Record<string, unknown>;
      for (const name of ["SESSION_SECRET", "TOKEN_ENCRYPTION_KEYS", "OTP_PEPPER", "SHOPIFY_API_SECRET", "META_APP_SECRET", "COGNITO_CLIENT_SECRET", "DATABASE_URL"]) {
        expect(vars[name]).toBeUndefined();
      }
      expect(vars.NODE_ENV).toBe("production");
    }
  });

  it("puts CloudFront (WAF, HTTPS only) in front of the function URL, with the origin secret", () => {
    t.app.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: "redirect-to-https" }),
        Origins: Match.arrayWith([Match.objectLike({ OriginCustomHeaders: [Match.objectLike({ HeaderName: "x-origin-verify" })] })]),
      }),
    });
    expect(JSON.stringify(t.app.toJSON())).toMatch(/resolve:secretsmanager:.*ORIGIN_VERIFY/);
  });

  it("serves Next's build files from a private bucket, never through the function", () => {
    const { main: dist } = distributions(t.app);
    const byId = Object.fromEntries((dist.Origins as Array<{ Id: string }>).map((o) => [o.Id, o])) as Record<string, Json>;
    const behavior = (pattern: string) => (dist.CacheBehaviors as Array<{ PathPattern: string; TargetOriginId: string }>).find((b) => b.PathPattern === pattern)!;
    const assets = behavior("/_next/static/*");
    expect(byId[assets.TargetOriginId].S3OriginConfig).toBeDefined();
    expect(byId[assets.TargetOriginId].OriginAccessControlId).toBeDefined();
    expect(byId[assets.TargetOriginId].OriginCustomHeaders).toBeUndefined();
    expect(byId[behavior("/api/*").TargetOriginId].OriginCustomHeaders).toBeDefined();

    const site = Object.values(t.app.findResources("AWS::S3::Bucket"));
    expect(site).toHaveLength(1);
    expect(site[0]!.Properties.PublicAccessBlockConfiguration).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
    t.app.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: "Allow", Principal: { Service: "cloudfront.amazonaws.com" }, Action: ["s3:GetObject", "s3:ListBucket"] })]) },
    });
    // Old builds' chunks stay for pages still open; fonts get their type (the upload's CLI can't tell).
    const resources = t.app.toJSON().Resources as Record<string, { Type: string; Properties: Json; DependsOn?: string[] }>;
    const ids = Object.keys(resources).filter((id) => resources[id]!.Type === "Custom::CDKBucketDeployment" && resources[id]!.Properties.DestinationBucketKeyPrefix !== "_fallback/");
    const uploads = ids.map((id) => resources[id]!.Properties);
    expect(uploads).toHaveLength(2);
    for (const u of uploads) {
      expect(u).toMatchObject({ Prune: false, DestinationBucketKeyPrefix: "_next/static/", SystemMetadata: { "cache-control": "public, max-age=31536000, immutable" } });
    }
    expect(uploads.find((u) => u.Include)).toMatchObject({ Include: ["*.woff2"], SystemMetadata: { "content-type": "font/woff2" } });
    expect(uploads.find((u) => !u.Include)).toMatchObject({ Exclude: ["*.woff2"] });
    // CloudFront and the API's live alias wait for both uploads.
    const waiting = (type: string) => Object.values(resources).filter((r) => r.Type === type && ids.every((id) => r.DependsOn?.includes(id))).length;
    expect(waiting("AWS::CloudFront::Distribution")).toBe(1);
    expect(waiting("AWS::Lambda::Alias")).toBe(1);
  });
});

describe("a page the function can't answer", () => {
  const origins = (dist: Json) => Object.fromEntries((dist.Origins as Array<{ Id: string }>).map((o) => [o.Id, o])) as Record<string, Json>;
  const members = (dist: Json) => (dist.OriginGroups.Items[0].Members.Items as Array<{ OriginId: string }>).map((m) => m.OriginId);

  it("gets the site's own page from the fallback, for the pages only (GET and HEAD, which CloudFront fails over)", () => {
    const { main } = distributions(t.app);
    expect(main.OriginGroups.Quantity).toBe(1);
    expect(main.DefaultCacheBehavior.TargetOriginId).toBe(main.OriginGroups.Items[0].Id);
    expect(main.DefaultCacheBehavior.AllowedMethods).toEqual(["GET", "HEAD"]);
    // 503 includes failing to connect, 504 timing out, 429 Lambda out of concurrency.
    expect([...main.OriginGroups.Items[0].FailoverCriteria.StatusCodes.Items].sort()).toEqual([429, 500, 502, 503, 504]);
    const [primary, secondary] = members(main).map((id) => origins(main)[id]);
    expect(primary.OriginCustomHeaders).toEqual([expect.objectContaining({ HeaderName: "x-origin-verify" })]);
    expect(secondary.DomainName).toEqual({ "Fn::GetAtt": [expect.stringMatching(/^FallbackCdn/), "DomainName"] });
    // The origin secret stays with the function.
    expect(secondary.OriginCustomHeaders).toBeUndefined();
    expect(secondary.CustomOriginConfig).toMatchObject({ OriginProtocolPolicy: "https-only", OriginSSLProtocols: ["TLSv1.2"] });
  });

  it("never stands in for the API: its paths keep the function's own answers, every method, the same policies", () => {
    const { main } = distributions(t.app);
    const api = (main.CacheBehaviors as Json[]).filter((b) => b.PathPattern !== "/_next/static/*");
    expect(api.map((b) => b.PathPattern)).toEqual([...API_PATH_PATTERNS]);
    // The function URL as an origin of its own: CDK binds a group's primary separately.
    const fn = origins(main)[members(main)[0]!];
    for (const b of api) {
      const target = origins(main)[b.TargetOriginId];
      expect(target, b.PathPattern).toBeDefined();
      expect([target.DomainName, target.OriginCustomHeaders, target.CustomOriginConfig], b.PathPattern).toEqual([fn.DomainName, fn.OriginCustomHeaders, fn.CustomOriginConfig]);
      expect(b.AllowedMethods, b.PathPattern).toHaveLength(7);
      for (const k of ["CachePolicyId", "OriginRequestPolicyId", "ResponseHeadersPolicyId", "FunctionAssociations", "ViewerProtocolPolicy"]) {
        expect(b[k], `${b.PathPattern} ${k}`).toEqual(main.DefaultCacheBehavior[k]);
      }
    }
    // No error page of the main distribution's own: it would replace the API's 502s and 503s too.
    expect(main.CustomErrorResponses).toBeUndefined();
  });

  it("answers every address of the fallback with the unavailable page, as a 503 nobody keeps", () => {
    const { fallback } = distributions(t.app);
    expect(fallback.CustomErrorResponses).toEqual([403, 404].map((ErrorCode) => ({ ErrorCode, ResponseCode: 503, ResponsePagePath: "/unavailable.html", ErrorCachingMinTTL: 0 })));
    expect(fallback.Origins).toHaveLength(1);
    expect(fallback.Origins[0]).toMatchObject({ OriginPath: "/_fallback", OriginAccessControlId: expect.anything(), S3OriginConfig: expect.anything() });
    expect(fallback.DefaultCacheBehavior).toMatchObject({ ViewerProtocolPolicy: "https-only", AllowedMethods: ["GET", "HEAD"] });
    const resources = t.app.toJSON().Resources as Record<string, { Type: string; Properties: Json; DependsOn?: string[] }>;
    const [id, upload] = Object.entries(resources).find(([, r]) => r.Type === "Custom::CDKBucketDeployment" && r.Properties.DestinationBucketKeyPrefix === "_fallback/")!;
    expect(upload.Properties.SystemMetadata).toEqual({ "cache-control": "no-store" });
    const dist = Object.values(resources).find((r) => r.Type === "AWS::CloudFront::Distribution" && r.Properties.DistributionConfig.Comment === fallback.Comment)!;
    expect(dist.DependsOn).toContain(id);
    t.app.hasOutput("FallbackDomain", { Value: { "Fn::GetAtt": [Match.stringLikeRegexp("^FallbackCdn"), "DomainName"] } });
  });
});

describe("the app's domain", () => {
  it("answers on bizinsights.io and www with the ACM certificate, TLS 1.2 or newer", () => {
    t.app.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Aliases: ["bizinsights.io", "www.bizinsights.io"],
        ViewerCertificate: {
          AcmCertificateArn: Match.stringLikeRegexp("^arn:aws:acm:us-east-1:605411278365:certificate/"),
          MinimumProtocolVersion: "TLSv1.2_2021",
          SslSupportMethod: "sni-only",
        },
      }),
    });
  });

  it("is every function's address (with the release) and Cognito's callback", () => {
    const fns = Object.values(t.app.findResources("AWS::Lambda::Function")).filter((f) => f.Properties.Handler === "index.handler" && String(f.Properties.Runtime).startsWith("nodejs"));
    expect(fns).toHaveLength(3);
    for (const f of fns) expect(f.Properties.Environment.Variables).toMatchObject({ APP_URL: "https://bizinsights.io", API_URL: "https://bizinsights.io/api" });
    const auth = JSON.stringify(t.auth.toJSON());
    expect(auth).toContain("https://bizinsights.io/auth/callback");
    expect(auth).toContain('\\"APP_URL\\":\\"https://bizinsights.io\\"');
    expect(auth).not.toContain("cloudfront.net");
  });

  it("leaves an environment without one on CloudFront's address", () => {
    const staging = synth({ env: "staging" });
    const dist = distributions(staging.app).main;
    expect(dist.Aliases).toBeUndefined();
    expect(dist.ViewerCertificate).toBeUndefined();
    for (const f of Object.values(staging.app.findResources("AWS::Lambda::Function")).filter((f) => f.Properties.Handler === "index.handler" && String(f.Properties.Runtime).startsWith("nodejs"))) {
      expect(f.Properties.Environment.Variables.APP_URL).toBeUndefined();
    }
  });
});

describe("the viewer-request function", () => {
  type Req = { method: string; uri: string; querystring: Record<string, { value: string; multiValue?: Array<{ value: string }> }>; headers: Record<string, { value: string }> };
  const run = (canonical: string | undefined, req: Partial<Req>, viewerIp = "203.0.113.9") => {
    const handler = new Function(`${viewerRequestCode(canonical)}\nreturn handler;`)() as (e: unknown) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
    return handler({ viewer: { ip: viewerIp }, request: { method: "GET", uri: "/", querystring: {}, headers: {}, ...req } });
  };

  it("passes the viewer's address and host on, over anything the client sent", () => {
    const r = run("bizinsights.io", { headers: { host: { value: "bizinsights.io" }, "x-insights-viewer-ip": { value: "1.2.3.4" } } });
    expect(r.headers["x-insights-viewer-ip"]).toEqual({ value: "203.0.113.9" });
    expect(r.headers["x-insights-viewer-host"]).toEqual({ value: "bizinsights.io" });
    expect(r.statusCode).toBeUndefined();
  });

  it("passes on the client's address from Cloudflare's proxy, and believes that header from nowhere else", () => {
    const via = (viewerIp: string, client = "198.51.100.7") =>
      run("bizinsights.io", { method: "POST", headers: { host: { value: "bizinsights.io" }, "cf-connecting-ip": { value: client } } }, viewerIp).headers["x-insights-viewer-ip"].value;
    for (const edge of ["172.70.1.2", "162.158.0.1", "104.23.255.254", "131.0.75.1", "2400:cb00:2049::1", "2606:4700:10::ac43:1", "2a06:98c7:ffff::1", "2c0f:f248::"]) {
      expect(via(edge), edge).toBe("198.51.100.7");
    }
    expect(via("172.70.1.2", "2001:db8::42")).toBe("2001:db8::42");
    for (const other of ["203.0.113.9", "172.72.0.1", "104.32.0.1", "2a06:98c8::1", "2606::1", "2001:db8::1", "::1"]) {
      expect(via(other), other).toBe(other);
    }
    // Not an address: the edge's own is kept.
    expect(via("172.70.1.2", "1.2.3.4, 5.6.7.8")).toBe("172.70.1.2");
  });

  it("passes on where the client is: Cloudflare's location behind its proxy, CloudFront's otherwise, never the client's own", () => {
    const geo = (viewerIp: string, headers: Record<string, string>) =>
      run("bizinsights.io", {
        method: "POST",
        headers: { host: { value: "bizinsights.io" }, ...Object.fromEntries(Object.entries(headers).map(([k, value]) => [k, { value }])) },
      }, viewerIp).headers["x-insights-viewer-geo"]?.value;
    const both = { "cf-ipcountry": "IN", "cf-region": "Kerala", "cf-ipcity": "Kochi", "cloudfront-viewer-country": "US", "cloudfront-viewer-country-region-name": "Virginia", "cloudfront-viewer-city": "Ashburn" };
    expect(geo("172.70.1.2", both)).toBe("IN|Kerala|Kochi");
    expect(geo("203.0.113.9", both)).toBe("US|Virginia|Ashburn");
    expect(geo("172.70.1.2", { "cf-ipcountry": "IN" })).toBe("IN||");
    expect(geo("203.0.113.9", { "cloudfront-viewer-country": "SG", "cloudfront-viewer-city": "New York" })).toBe("SG||New%20York");
    // Sent by the client itself (not from Cloudflare's addresses): ignored, and its own header dropped.
    expect(geo("203.0.113.9", { "cf-ipcountry": "KP", "x-insights-viewer-geo": "KP||" })).toBeUndefined();
  });

  it("sends page requests on other names to the domain, path and query parameters as received", () => {
    const querystring = { shop: { value: "a.myshopify.com" }, hmac: { value: "ab%2Bc" }, embedded: { value: "" }, id: { value: "1", multiValue: [{ value: "1" }, { value: "2" }] } };
    for (const host of ["d2mr8m2p1qkh58.cloudfront.net", "www.bizinsights.io", "WWW.BizInsights.io"]) {
      const r = run("bizinsights.io", { uri: "/api/shopify/launch", querystring, headers: { host: { value: host } } });
      expect(r.statusCode).toBe(301);
      expect(r.headers.location.value).toBe("https://bizinsights.io/api/shopify/launch?shop=a.myshopify.com&hmac=ab%2Bc&embedded&id=1&id=2");
    }
    expect(run("bizinsights.io", { method: "HEAD", uri: "/login", headers: { host: { value: "www.bizinsights.io" } } }).headers.location.value).toBe("https://bizinsights.io/login");
    expect(run("bizinsights.io", { headers: { host: { value: "BizInsights.io" } } }).statusCode).toBeUndefined();
  });

  it("serves other methods where they arrive (webhooks and pixel events don't follow redirects)", () => {
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      const r = run("bizinsights.io", { method, uri: "/api/webhooks/shopify", headers: { host: { value: "d2mr8m2p1qkh58.cloudfront.net" } } });
      expect(r.statusCode).toBeUndefined();
      expect(r.headers["x-insights-viewer-host"]).toEqual({ value: "d2mr8m2p1qkh58.cloudfront.net" });
    }
  });

  it("redirects nothing without a domain", () => {
    expect(run(undefined, { headers: { host: { value: "d2mr8m2p1qkh58.cloudfront.net" } } }).statusCode).toBeUndefined();
  });

  it("fits CloudFront Functions (no modules, under 10 KB)", () => {
    const code = viewerRequestCode("bizinsights.io");
    expect(code).not.toMatch(/\b(import|require)\b/);
    expect(code.length).toBeLessThan(10_240);
  });
});

describe("the edge stack", () => {
  it("rate-limits the API per IP and blocks known-bad traffic; the common rule set only counts", () => {
    const acl = Object.values(t.edge.findResources("AWS::WAFv2::WebACL"))[0]!.Properties;
    expect(acl.Scope).toBe("CLOUDFRONT");
    const rules = Object.fromEntries((acl.Rules as Array<{ Name: string }>).map((r) => [r.Name, r])) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    // Per address, and one address is often an office or a mobile carrier's NAT: the same figure
    // as the app's own GLOBAL_LIMIT_PER_MIN (apps/aws/src/app.ts).
    expect(rules["api-rate-per-ip"].Statement.RateBasedStatement.Limit).toBe(1500);
    expect(rules["api-rate-per-ip"].Statement.RateBasedStatement.AggregateKeyType).toBe("IP");
    expect(rules["aws-ip-reputation"].OverrideAction).toEqual({ None: {} });
    expect(rules["aws-common-count-only"].OverrideAction).toEqual({ Count: {} });
  });

  it("matches the API and its exempt paths the way the app routes them, so /api/webhooks/../auth/login is limited", () => {
    const acl = Object.values(t.edge.findResources("AWS::WAFv2::WebACL"))[0]!.Properties;
    type ByteMatch = { FieldToMatch: Record<string, unknown>; SearchString: string; TextTransformations: unknown };
    const byteMatches: ByteMatch[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          if (k === "ByteMatchStatement") byteMatches.push(x as ByteMatch);
          walk(x);
        }
      }
    };
    walk(acl.Rules);
    const onPath = byteMatches.filter((m) => "UriPath" in m.FieldToMatch);
    expect(onPath.map((m) => m.SearchString)).toEqual(expect.arrayContaining(["/api/", "/api/webhooks/", "/pixel/"]));
    for (const m of onPath) expect(m.TextTransformations, m.SearchString).toEqual([{ Priority: 0, Type: "URL_DECODE" }, { Priority: 1, Type: "NORMALIZE_PATH" }]);
  });
});

describe("the edge stack behind Cloudflare", () => {
  const acl = () => Object.values(t.edge.findResources("AWS::WAFv2::WebACL"))[0]!.Properties;
  const rule = (name: string) => (acl().Rules as Array<{ Name: string }>).find((r) => r.Name === name) as any; // eslint-disable-line @typescript-eslint/no-explicit-any

  it("knows Cloudflare's published ranges", () => {
    const sets = Object.values(t.edge.findResources("AWS::WAFv2::IPSet")).map((s) => s.Properties);
    expect(sets.map((s) => s.IPAddressVersion).sort()).toEqual(["IPV4", "IPV6"]);
    expect(sets.find((s) => s.IPAddressVersion === "IPV4").Addresses).toContain("172.64.0.0/13");
    expect(sets.find((s) => s.IPAddressVersion === "IPV6").Addresses).toContain("2606:4700::/32");
    for (const s of sets) {
      expect(s.Scope).toBe("CLOUDFRONT");
      // WAF refuses anything else in a description (a quote or a bracket failed a deploy).
      expect(s.Description).toMatch(/^[\w+=:#@/\-,.][\w+=:#@/\-,.\s]+[\w+=:#@/\-,.]$/);
    }
  });

  it("rate-limits requests through Cloudflare by the client's address, everything else by the viewer's", () => {
    const viaCloudflare = rule("api-rate-per-client-via-cloudflare").Statement.RateBasedStatement;
    expect(viaCloudflare.AggregateKeyType).toBe("FORWARDED_IP");
    expect(viaCloudflare.ForwardedIPConfig).toEqual({ HeaderName: "cf-connecting-ip", FallbackBehavior: "NO_MATCH" });
    expect(viaCloudflare.Limit).toBe(1500);
    const scope = (r: { ScopeDownStatement: { AndStatement: { Statements: unknown[] } } }) => JSON.stringify(r.ScopeDownStatement.AndStatement.Statements.at(-1));
    expect(scope(viaCloudflare)).toMatch(/^\{"OrStatement".*IPSetReferenceStatement/);
    expect(scope(rule("api-rate-per-ip").Statement.RateBasedStatement)).toMatch(/^\{"NotStatement".*IPSetReferenceStatement/);
  });

  it("doesn't judge Cloudflare's own addresses by Amazon's reputation list", () => {
    expect(JSON.stringify(rule("aws-ip-reputation").Statement.ManagedRuleGroupStatement.ScopeDownStatement)).toMatch(/^\{"NotStatement".*IPSetReferenceStatement/);
  });
});

describe("Cognito's emails", () => {
  type Resource = { Properties: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const only = (tpl: Template, type: string) => {
    const found = Object.entries(tpl.findResources(type)) as Array<[string, Resource]>;
    expect(found, type).toHaveLength(1);
    return found[0]!;
  };

  it("go to the custom email sender, with codes encrypted under this stack's KMS key", () => {
    const [fnId] = only(t.auth, "AWS::Lambda::Function");
    const [keyId] = only(t.auth, "AWS::KMS::Key");
    const [, pool] = only(t.auth, "AWS::Cognito::UserPool");
    // cognito.yaml's switch, given both values: on.
    expect(pool.Properties.LambdaConfig).toEqual({
      "Fn::If": ["HasCustomEmailSender", { CustomEmailSender: { LambdaArn: { "Fn::GetAtt": [fnId, "Arn"] }, LambdaVersion: "V1_0" }, KMSKeyID: { "Fn::GetAtt": [keyId, "Arn"] } }, { Ref: "AWS::NoValue" }],
    });
    const tpl = t.auth.toJSON();
    expect(tpl.Conditions.HasCustomEmailSender).toEqual({ "Fn::Equals": ["ENABLED", "ENABLED"] });
    expect(tpl.Parameters?.CustomEmailSenderArn).toBeUndefined();
    // Cognito sends nothing itself, but its own sender stays configured underneath.
    expect(pool.Properties.EmailConfiguration["Fn::If"][2]).toEqual({ EmailSendingAccount: "COGNITO_DEFAULT" });
    t.auth.hasResourceProperties("AWS::KMS::Alias", { AliasName: "alias/insights-production-cognito-email" });
  });

  it("lets only this pool invoke the sender, and the sender only decrypt with its key and read the app secret", () => {
    const [fnId] = only(t.auth, "AWS::Lambda::Function");
    const [keyId] = only(t.auth, "AWS::KMS::Key");
    const [poolId] = only(t.auth, "AWS::Cognito::UserPool");
    t.auth.hasResourceProperties("AWS::Lambda::Permission", {
      Action: "lambda:InvokeFunction",
      Principal: "cognito-idp.amazonaws.com",
      FunctionName: { "Fn::GetAtt": [fnId, "Arn"] },
      SourceArn: { "Fn::GetAtt": [poolId, "Arn"] },
      SourceAccount: "605411278365",
    });
    t.auth.resourceCountIs("AWS::Lambda::Permission", 1);
    const statements = Object.values(t.auth.findResources("AWS::IAM::Policy"))
      .filter((p) => JSON.stringify(p.Properties.Roles).includes("CognitoEmail"))
      .flatMap((p) => p.Properties.PolicyDocument.Statement as Array<{ Action: string | string[]; Resource: unknown }>);
    expect(statements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ Action: "kms:Decrypt", Resource: { "Fn::GetAtt": [keyId, "Arn"] } }),
        expect.objectContaining({ Action: "secretsmanager:GetSecretValue", Resource: "arn:aws:secretsmanager:ap-southeast-2:605411278365:secret:insights/production/app-*" }),
      ]),
    );
    expect(statements.flatMap((s) => [s.Action].flat()).sort()).toEqual(["kms:Decrypt", "secretsmanager:GetSecretValue"]);
  });

  it("runs the package's own entry outside the VPC, retried by Lambda, with an alarm on failures", () => {
    const [, fn] = only(t.auth, "AWS::Lambda::Function");
    const [keyId] = only(t.auth, "AWS::KMS::Key");
    expect(fn.Properties).toMatchObject({ FunctionName: "insights-production-cognito-email", Handler: "cognito-email.handler", Architectures: ["arm64"] });
    expect(fn.Properties.VpcConfig).toBeUndefined();
    expect(fn.Properties.Environment.Variables).toMatchObject({
      NODE_ENV: "production",
      APP_URL: "https://bizinsights.io",
      API_URL: "https://bizinsights.io/api",
      EMAIL_FROM: "bizinsights <no-reply@bizinsights.io>",
      // The codes come from the support sender, signed with the support address.
      OTP_FROM_EMAIL: "support@bizinsights.io",
      OTP_FROM_NAME: "BizInsights Support",
      SUPPORT_EMAIL: "support@bizinsights.io",
      APP_SECRET_ARN: "insights/production/app",
      COGNITO_EMAIL_KEY_ARN: { "Fn::GetAtt": [keyId, "Arn"] },
    });
    for (const name of ["RESEND_API_KEY", "SESSION_SECRET", "COGNITO_CLIENT_SECRET"]) expect(fn.Properties.Environment.Variables[name]).toBeUndefined();
    t.auth.hasResourceProperties("AWS::Lambda::EventInvokeConfig", { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 3600 });
    t.auth.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "insights-production-cognito-email-errors",
      MetricName: "Errors",
      Threshold: 1,
      AlarmActions: ["arn:aws:sns:ap-southeast-2:605411278365:insights-production-alarms"],
    });
  });

  it("stay with Cognito's own sender when switched off, and in staging", () => {
    for (const auth of [synth({ cognitoEmail: "off" }).auth, synth({ env: "staging" }).auth]) {
      auth.resourceCountIs("AWS::KMS::Key", 0);
      auth.resourceCountIs("AWS::Lambda::Function", 0);
      auth.resourceCountIs("AWS::Lambda::Permission", 0);
      // The template's switch stays at its default, so HasCustomEmailSender is false.
      expect(auth.toJSON().Parameters.CustomEmailSenderState).toMatchObject({ Type: "String", Default: "DISABLED" });
    }
    synth({ env: "staging", cognitoEmail: "on" }).auth.resourceCountIs("AWS::Lambda::Function", 1);
  });
});

describe("Cognito sign-in", () => {
  type Resource = { Properties: Record<string, any>; Condition?: string; DependsOn?: string[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** The Auth stack alone, for a configuration the context can't express. */
  function synthAuth(override: Partial<import("../lib/config.js").EnvConfig>) {
    const app = new App();
    const cfg = { ...envConfig((k) => app.node.tryGetContext(k)), ...override };
    const env = { account: cfg.account, region: cfg.region };
    const edge = new EdgeStack(app, "E", cfg, { env: { account: cfg.account, region: "us-east-1" }, crossRegionReferences: true });
    const data = new DataStack(app, "D", cfg, { env });
    const appStack = new AppStack(app, "A", cfg, data, edge.webAclArn, { env, crossRegionReferences: true });
    return Template.fromStack(new AuthStack(app, "U", cfg, { env, appUrl: appStack.appUrl, apiRole: appStack.apiRole, runtimeParam: appStack.runtimeParam }));
  }
  const resource = (tpl: Template, id: string) => tpl.toJSON().Resources[id] as Resource;
  const ownDomain = { name: "auth.bizinsights.io", certificateArn: "arn:aws:acm:us-east-1:605411278365:certificate/0a1b2c3d-1234-5678-9abc-def012345678", inUse: false };
  const PREFIX_DOMAIN = "https://insights-605411278365.auth.ap-southeast-2.amazoncognito.com";

  it("offers two-step verification with an authenticator app to those who turn it on, and asks nobody else", () => {
    const pool = resource(t.auth, "UserPool");
    expect(pool.Properties.MfaConfiguration).toBe("OPTIONAL");
    expect(pool.Properties.EnabledMfas).toEqual(["SOFTWARE_TOKEN_MFA"]);
    // No text messages: nothing to configure or pay for there.
    expect(pool.Properties.SmsConfiguration).toBeUndefined();
  });

  it("keeps the prefix domain alone, exactly as deployed before, while no own domain is set", () => {
    const tpl = synthAuth({ cognitoCustomDomain: undefined });
    const json = tpl.toJSON();
    expect(resource(tpl, "UserPoolDomain").Properties).toEqual({ UserPoolId: { Ref: "UserPool" }, Domain: "insights-605411278365", ManagedLoginVersion: 2 });
    // The own domain's resource is there but switched off: its parameter keeps the empty default.
    expect(resource(tpl, "CustomUserPoolDomain").Condition).toBe("HasCustomDomain");
    expect(json.Conditions.HasCustomDomain).toEqual({ "Fn::Not": [{ "Fn::Equals": [{ Ref: "CustomDomain" }, ""] }] });
    expect(json.Conditions.UsesCustomDomain).toEqual({ "Fn::And": [{ Condition: "HasCustomDomain" }, { "Fn::Equals": [{ Ref: "CustomDomainInUse" }, "true"] }] });
    expect(json.Parameters.CustomDomain).toMatchObject({ Type: "String", Default: "" });
    expect(json.Parameters.CustomDomainInUse).toMatchObject({ Type: "String", Default: "false", AllowedValues: ["true", "false"] });
    // The outputs resolve to what they were.
    expect(json.Outputs.Domain.Value["Fn::If"]).toEqual(["UsesCustomDomain", { "Fn::Sub": "https://${CustomDomain}" }, { "Fn::Sub": "https://insights-605411278365.auth.${AWS::Region}.amazoncognito.com" }]);
    expect(json.Outputs.ProviderRedirectUri.Value["Fn::If"][2]).toEqual({ "Fn::Sub": "https://insights-605411278365.auth.${AWS::Region}.amazoncognito.com/oauth2/idpresponse" });
    expect(JSON.stringify(json)).toContain(`\\"COGNITO_DOMAIN\\":\\"${PREFIX_DOMAIN}\\"`);
    const runtime = Object.values(tpl.findResources("AWS::SSM::Parameter"))[0] as Resource;
    expect(runtime.DependsOn ?? []).not.toContain("CustomUserPoolDomain");
  });

  it("production: sign-in goes through the own domain auth.bizinsights.io, with its own us-east-1 certificate, the prefix domain kept beside it", () => {
    // Step two of docs/cognito-setup.md "Own sign-in domain" (2026-10-20).
    expect(envConfig(() => undefined).cognitoCustomDomain).toEqual({
      name: "auth.bizinsights.io",
      certificateArn: "arn:aws:acm:us-east-1:605411278365:certificate/b0849d46-9714-4de4-b893-a9ab1171761d",
      inUse: true,
    });
    expect(resource(t.auth, "CustomUserPoolDomain").Properties).toMatchObject({ Domain: "auth.bizinsights.io", ManagedLoginVersion: 2 });
    expect(resource(t.auth, "UserPoolDomain").Properties).toEqual({ UserPoolId: { Ref: "UserPool" }, Domain: "insights-605411278365", ManagedLoginVersion: 2 });
    expect(JSON.stringify(t.auth.toJSON())).toContain('\\"COGNITO_DOMAIN\\":\\"https://auth.bizinsights.io\\"');
    const runtime = Object.values(t.auth.findResources("AWS::SSM::Parameter"))[0] as Resource;
    expect(runtime.DependsOn).toContain("CustomUserPoolDomain");
  });

  it("adds an own domain beside the prefix domain and, until it is in use, leaves sign-in on the prefix domain", () => {
    const tpl = synthAuth({ cognitoCustomDomain: ownDomain });
    const json = tpl.toJSON();
    expect(json.Conditions.HasCustomDomain).toEqual({ "Fn::Not": [{ "Fn::Equals": ["auth.bizinsights.io", ""] }] });
    expect(resource(tpl, "CustomUserPoolDomain").Properties).toEqual({
      UserPoolId: { Ref: "UserPool" },
      Domain: "auth.bizinsights.io",
      CustomDomainConfig: { CertificateArn: ownDomain.certificateArn },
      ManagedLoginVersion: 2,
    });
    // The prefix domain stays exactly as it is: never replaced.
    expect(resource(tpl, "UserPoolDomain").Properties).toEqual({ UserPoolId: { Ref: "UserPool" }, Domain: "insights-605411278365", ManagedLoginVersion: 2 });
    // Nothing of sign-in has moved: the app and Google's redirect URI still name the prefix domain,
    // so Continue with Google keeps working while the DNS record and Google's client are readied.
    expect(json.Conditions.UsesCustomDomain).toEqual({ "Fn::And": [{ Condition: "HasCustomDomain" }, { "Fn::Equals": ["false", "true"] }] });
    expect(json.Outputs.Domain.Value["Fn::If"][0]).toBe("UsesCustomDomain");
    expect(json.Outputs.ProviderRedirectUri.Value["Fn::If"][0]).toBe("UsesCustomDomain");
    expect(JSON.stringify(json)).toContain(`\\"COGNITO_DOMAIN\\":\\"${PREFIX_DOMAIN}\\"`);
    const runtime = Object.values(tpl.findResources("AWS::SSM::Parameter"))[0] as Resource;
    expect(runtime.DependsOn ?? []).not.toContain("CustomUserPoolDomain");
    // What the two steps in between need: the DNS record's target, and the redirect URI for Google's client.
    expect(json.Outputs.CustomDomainTarget).toMatchObject({ Condition: "HasCustomDomain", Value: { "Fn::GetAtt": "CustomUserPoolDomain.CloudFrontDistribution" } });
    expect(json.Outputs.CustomDomainRedirectUri).toMatchObject({ Condition: "HasCustomDomain", Value: { "Fn::Sub": "https://auth.bizinsights.io/oauth2/idpresponse" } });
  });

  it("moves the app and Google's redirect URI to the own domain once it is in use", () => {
    const tpl = synthAuth({ cognitoCustomDomain: { ...ownDomain, inUse: true } });
    const json = tpl.toJSON();
    expect(json.Conditions.UsesCustomDomain).toEqual({ "Fn::And": [{ Condition: "HasCustomDomain" }, { "Fn::Equals": ["true", "true"] }] });
    expect(json.Outputs.Domain.Value["Fn::If"][1]).toEqual({ "Fn::Sub": "https://auth.bizinsights.io" });
    expect(json.Outputs.ProviderRedirectUri.Value["Fn::If"][1]).toEqual({ "Fn::Sub": "https://auth.bizinsights.io/oauth2/idpresponse" });
    expect(JSON.stringify(json)).toContain('\\"COGNITO_DOMAIN\\":\\"https://auth.bizinsights.io\\"');
    // The functions get the new address only once Cognito serves the domain.
    const runtime = Object.values(tpl.findResources("AWS::SSM::Parameter"))[0] as Resource;
    expect(runtime.DependsOn).toContain("CustomUserPoolDomain");
    // Both domains stay: a sign-in that started on the prefix domain still finishes there.
    expect(resource(tpl, "UserPoolDomain").Properties).toEqual({ UserPoolId: { Ref: "UserPool" }, Domain: "insights-605411278365", ManagedLoginVersion: 2 });
  });

  it("refuses an own domain whose certificate isn't in us-east-1", () => {
    expect(() => synthAuth({ cognitoCustomDomain: { ...ownDomain, certificateArn: "arn:aws:acm:ap-southeast-2:605411278365:certificate/0a1b2c3d" } })).toThrow(/us-east-1/);
  });
});

describe("IAM", () => {
  it("has no IAM user or access key anywhere (roles only)", () => {
    for (const tpl of [t.ci, t.app, t.data, t.auth, t.audit]) {
      tpl.resourceCountIs("AWS::IAM::User", 0);
      tpl.resourceCountIs("AWS::IAM::AccessKey", 0);
    }
  });

  it("lets only the deploy workflow on main, in this repository's production environment, deploy from GitHub", () => {
    // The immutable subject GitHub sends for this repository (owner and repository ids), not the
    // bare name; and the workflow file and branch, which the subject doesn't name.
    t.ci.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "insights-production-github-deploy",
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Condition: {
              StringEquals: Match.exact({
                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                "token.actions.githubusercontent.com:sub": "repo:html-proof@68529971/pixmagic-projects@1413246051:environment:production",
                "token.actions.githubusercontent.com:job_workflow_ref": "html-proof/pixmagic-projects/.github/workflows/aws-deploy.yml@refs/heads/main",
                "token.actions.githubusercontent.com:ref": "refs/heads/main",
              }),
            },
          }),
        ],
      },
    });
    // The workflow the trust names is the one that deploys.
    const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/aws-deploy.yml"), "utf8");
    expect(workflow).toMatch(/^\s+environment: production\s*$/m);
    expect(workflow).toMatch(/^\s+id-token: write\s*$/m);
  });

  it("lets only the deploy job ask for the token, and keeps the app's dependencies out of that job", () => {
    const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/aws-deploy.yml"), "utf8");
    const [top, rest] = workflow.split(/^jobs:\s*$/m) as [string, string];
    const [build, deploy] = rest.split(/^ {2}deploy:\s*$/m) as [string, string];
    // Not for the whole workflow, not for the job that installs and builds everything.
    expect(top).not.toMatch(/id-token/);
    expect(build).not.toMatch(/id-token/);
    expect(build).not.toMatch(/environment: production/);
    expect(build).not.toMatch(/configure-aws-credentials/);
    expect(build).toContain("pnpm --filter @app/aws build");
    // The deploy job: the token, the CDK tools only and no install scripts, and the package built above.
    expect(deploy).toMatch(/^\s+id-token: write\s*$/m);
    expect(deploy).toMatch(/^\s+needs: build\s*$/m);
    const installs = deploy.match(/pnpm install[^\r\n]*/g) ?? [];
    expect(installs).toEqual(["pnpm install --frozen-lockfile --ignore-scripts --filter @infra/cdk"]);
    expect(deploy).not.toMatch(/--filter @app\/aws (build|test)|pnpm (--filter \S+ )*test/);
    expect(deploy).toContain("fail-on-cache-miss: true");
    // Dependency install scripts, anywhere this repository is installed, only for these.
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { pnpm: { onlyBuiltDependencies: string[] } };
    expect(pkg.pnpm.onlyBuiltDependencies).toEqual(["@prisma/engines", "esbuild", "prisma"]);
  });

  it("proves the deploy role's next trust on roles that grant nothing: one must admit the deploy workflow, two must refuse it", () => {
    const repo = "html-proof/pixmagic-projects";
    const base = {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": "repo:html-proof@68529971/pixmagic-projects@1413246051:environment:production",
      "token.actions.githubusercontent.com:job_workflow_ref": `${repo}/.github/workflows/aws-deploy.yml@refs/heads/main`,
      "token.actions.githubusercontent.com:ref": "refs/heads/main",
    };
    const expected: Record<string, Record<string, string>> = {
      "insights-production-github-trust-check": base,
      // Each changes one claim, to a ref git can't create ("..").
      "insights-production-github-trust-check-wrong-workflow": { ...base, "token.actions.githubusercontent.com:job_workflow_ref": `${repo}/.github/workflows/aws-deploy.yml@refs/heads/never..matches` },
      "insights-production-github-trust-check-wrong-ref": { ...base, "token.actions.githubusercontent.com:ref": "refs/heads/never..matches" },
    };
    type Role = { Properties: { RoleName: string; AssumeRolePolicyDocument: { Statement: Array<{ Condition: unknown }> }; ManagedPolicyArns?: unknown; Policies?: unknown } };
    const roles = Object.entries(t.ci.findResources("AWS::IAM::Role") as Record<string, Role>).filter(([, r]) => r.Properties.RoleName.includes("trust-check"));
    expect(Object.fromEntries(roles.map(([, r]) => [r.Properties.RoleName, r.Properties.AssumeRolePolicyDocument.Statement.map((s) => s.Condition)]))).toEqual(
      Object.fromEntries(Object.entries(expected).map(([name, cond]) => [name, [{ StringEquals: cond }]])),
    );
    // No permissions of any kind: no managed or inline policy, and no AWS::IAM::Policy names them.
    type Policy = { Properties: { Roles?: Array<{ Ref: string }>; PolicyDocument: { Statement: Array<{ Action: string | string[]; Resource: unknown }> } } };
    const policies = Object.values(t.ci.findResources("AWS::IAM::Policy") as Record<string, Policy>);
    for (const [id, r] of roles) {
      expect(r.Properties.ManagedPolicyArns).toBeUndefined();
      expect(r.Properties.Policies).toBeUndefined();
      expect(policies.some((p) => p.Properties.Roles?.some((ref) => ref.Ref === id))).toBe(false);
    }
    // The deploy role may read exactly those three roles (STS refuses a missing role too).
    const getRole = policies.flatMap((p) => p.Properties.PolicyDocument.Statement).filter((s) => [s.Action].flat().includes("iam:GetRole"));
    expect(getRole).toHaveLength(1);
    expect(getRole[0]!.Action).toBe("iam:GetRole");
    expect(getRole[0]!.Resource).toEqual(roles.map(([id]) => ({ "Fn::GetAtt": [id, "Arn"] })));
  });

  it("lets the deploy role restart exactly the three functions when the runtime settings change, and read only that parameter", () => {
    type Statement = { Effect: string; Action: string | string[]; Resource: unknown };
    type Policy = { Properties: { PolicyDocument: { Statement: Statement[] } } };
    const statements = Object.values(t.ci.findResources("AWS::IAM::Policy")).flatMap((p) => (p as Policy).Properties.PolicyDocument.Statement);
    const granting = (action: string) => statements.filter((s) => [s.Action].flat().includes(action));
    // The workflow's restart step (aws-deploy.yml) reads the parameter before and after the deploy...
    const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/aws-deploy.yml"), "utf8");
    expect(workflow).toContain("aws ssm get-parameter --name /insights/production/runtime");
    expect(workflow).toMatch(/for f in api jobs cron; do\s+n="insights-production-\$f"/);
    expect(granting("ssm:GetParameter")).toEqual([{ Effect: "Allow", Action: "ssm:GetParameter", Resource: "arn:aws:ssm:ap-southeast-2:605411278365:parameter/insights/production/runtime" }]);
    // ...then republishes those functions, on their unqualified ARNs (the step's --function-name), and nothing else.
    const fns = ["api", "jobs", "cron"].map((f) => `arn:aws:lambda:ap-southeast-2:605411278365:function:insights-production-${f}`);
    const restart = granting("lambda:PublishVersion");
    expect(restart).toEqual([{ Effect: "Allow", Action: ["lambda:UpdateFunctionConfiguration", "lambda:PublishVersion"], Resource: fns }]);
    expect(granting("lambda:UpdateFunctionConfiguration")).toEqual(restart);
    // Together, or the first deploy that changes the parameter fails at the publish and rolls back.
    expect(granting("lambda:UpdateAlias").length).toBe(1);
    // Never a way to hand the functions another execution role.
    expect(granting("iam:PassRole")).toEqual([]);
    for (const s of statements) expect([s.Action].flat().some((a) => a === "*" || a === "lambda:*" || a === "ssm:*")).toBe(false);
  });

  it("lets the deploy role read everything the workflow's smoke tests check", () => {
    type Policy = { Properties: { PolicyDocument: { Statement: Array<{ Action: string | string[] }> } } };
    const actions = Object.values(t.ci.findResources("AWS::IAM::Policy")).flatMap((p) => (p as Policy).Properties.PolicyDocument.Statement.flatMap((s) => [s.Action].flat()));
    for (const needed of ["rds:DescribeDBInstances", "s3:GetBucketPublicAccessBlock", "sqs:GetQueueUrl", "sqs:GetQueueAttributes", "logs:DescribeLogStreams", "cloudwatch:GetMetricStatistics", "lambda:GetAlias"]) {
      expect(actions).toContain(needed);
    }
  });
});

describe("S3 access logs (Trusted Advisor Amazon S3 Server Access Logs Enabled)", () => {
  type Bucket = { Properties: { BucketName: string; LoggingConfiguration?: { DestinationBucketName: unknown; LogFilePrefix: string } } };
  const isLogBucket = (b: Bucket) => /-s3-logs-/.test(b.Properties.BucketName);
  const buckets = (stack: "data" | "app" | "audit" | "edge") => Object.values(t[stack].findResources("AWS::S3::Bucket")) as Bucket[];

  it("has one log bucket per Region: Sydney in the Data stack, us-east-1 in the Edge stack", () => {
    expect(buckets("data").filter(isLogBucket).map((b) => b.Properties.BucketName)).toEqual(["insights-production-s3-logs-605411278365"]);
    expect(buckets("edge").filter(isLogBucket).map((b) => b.Properties.BucketName)).toEqual(["insights-production-s3-logs-us-east-1-605411278365"]);
    expect(buckets("app").filter(isLogBucket)).toEqual([]);
    expect(buckets("audit").filter(isLogBucket)).toEqual([]);
  });

  it("logs every other bucket's requests to its Region's log bucket, under the bucket's name", () => {
    const logged = (["data", "app", "audit"] as const).flatMap((stack) => buckets(stack).filter((b) => !isLogBucket(b)));
    expect(logged.map((b) => b.Properties.BucketName).sort()).toEqual([
      "insights-account-trail-605411278365",
      "insights-production-artifacts-605411278365",
      "insights-production-payloads-605411278365",
      "insights-production-site-605411278365",
    ]);
    for (const b of logged) {
      expect(b.Properties.LoggingConfiguration?.DestinationBucketName, b.Properties.BucketName).toBeDefined();
      expect(b.Properties.LoggingConfiguration?.LogFilePrefix).toBe(`${b.Properties.BucketName}/`);
    }
    // The Data stack's own two name the bucket itself; the others import its name from that stack.
    const [sydney] = buckets("data").filter(isLogBucket);
    const logicalId = Object.entries(t.data.findResources("AWS::S3::Bucket")).find(([, b]) => b === sydney)![0];
    for (const b of buckets("data").filter((b) => !isLogBucket(b))) expect(b.Properties.LoggingConfiguration?.DestinationBucketName).toEqual({ Ref: logicalId });
    for (const b of [...buckets("app"), ...buckets("audit")]) expect(JSON.stringify(b.Properties.LoggingConfiguration?.DestinationBucketName)).toContain("Fn::ImportValue");
  });

  it("never logs a log bucket (S3: a destination bucket should not have logging on)", () => {
    for (const b of [...buckets("data"), ...buckets("edge")].filter(isLogBucket)) expect(b.Properties.LoggingConfiguration).toBeUndefined();
  });

  it("keeps log files 90 days in a private, versioned bucket under S3's own keys, and lets S3's logging service write from this account's buckets only", () => {
    for (const stack of ["data", "edge"] as const) {
      const [bucket] = buckets(stack).filter(isLogBucket) as Array<Bucket & { Properties: Record<string, any> }>; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(bucket!.Properties.PublicAccessBlockConfiguration).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
      expect(bucket!.Properties.VersioningConfiguration).toEqual({ Status: "Enabled" });
      expect(bucket!.Properties.OwnershipControls).toEqual({ Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] });
      expect(bucket!.Properties.BucketEncryption.ServerSideEncryptionConfiguration).toEqual([{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }]);
      expect(bucket!.Properties.LifecycleConfiguration.Rules).toEqual(
        expect.arrayContaining([expect.objectContaining({ ExpirationInDays: 90, NoncurrentVersionExpiration: { NoncurrentDays: 1 } }), expect.objectContaining({ ExpiredObjectDeleteMarker: true })]),
      );
      t[stack].hasResource("AWS::S3::Bucket", { Properties: { BucketName: bucket!.Properties.BucketName }, DeletionPolicy: "Retain" });
      t[stack].hasResourceProperties("AWS::S3::BucketPolicy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            {
              Sid: "S3ServerAccessLogsPolicy",
              Effect: "Allow",
              Principal: { Service: "logging.s3.amazonaws.com" },
              Action: "s3:PutObject",
              Resource: { "Fn::Join": ["", [Match.anyValue(), "/*"]] },
              Condition: { StringEquals: { "aws:SourceAccount": "605411278365" } },
            },
          ]),
        },
      });
    }
  });

  it("turns logging on for the bucket cdk bootstrap made in each Region, which no stack owns, and off again if the resource goes", () => {
    for (const [stack, bucket] of [
      ["audit", "cdk-hnb659fds-assets-605411278365-ap-southeast-2"],
      ["edge", "cdk-hnb659fds-assets-605411278365-us-east-1"],
    ] as const) {
      const calls = Object.values(t[stack].findResources("Custom::AWS")).map((r) => r.Properties as Record<string, unknown>);
      expect(calls, stack).toHaveLength(1);
      const [call] = calls;
      for (const when of ["Create", "Update"]) {
        const text = JSON.stringify(call![when]);
        expect(text).toContain('\\"action\\":\\"putBucketLogging\\"');
        expect(text).toContain(`\\"Bucket\\":\\"${bucket}\\"`);
        expect(text).toContain(`\\"TargetPrefix\\":\\"${bucket}/\\"`);
        // The log bucket's name: the Edge stack's own (Ref), the Data stack's for the audit stack (import).
        expect(text).toMatch(stack === "edge" ? /TargetBucket.{0,40}"Ref"/ : /TargetBucket.{0,40}"Fn::ImportValue"/);
      }
      expect(JSON.stringify(call!.Delete)).toContain('\\"BucketLoggingStatus\\":{}');
      expect(call!.InstallLatestAwsSdk).toBeFalsy();
      // May set that one bucket's logging and nothing else.
      const policies = Object.values(t[stack].findResources("AWS::IAM::Policy")).map((p) => p.Properties.PolicyDocument.Statement as Array<{ Action: unknown; Resource: unknown }>);
      expect(policies.flat().filter((s) => JSON.stringify(s.Action).includes("s3:"))).toEqual([{ Effect: "Allow", Action: "s3:PutBucketLogging", Resource: `arn:aws:s3:::${bucket}` }]);
    }
  });

  it("gives staging its own Sydney log bucket and leaves the account's buckets to production", () => {
    const staging = synth({ env: "staging" });
    const names = Object.values(staging.data.findResources("AWS::S3::Bucket")).map((b) => b.Properties.BucketName as string);
    expect(names).toContain("insights-staging-s3-logs-605411278365");
    expect(Object.values(staging.edge.findResources("AWS::S3::Bucket"))).toEqual([]);
    expect(Object.values(staging.edge.findResources("Custom::AWS"))).toEqual([]);
  });
});

describe("Lambda runtimes (Trusted Advisor AWS Lambda Functions Using Deprecated Runtimes)", () => {
  it("runs every Node function, the app's and CDK's helpers alike, on Node 24", () => {
    const fns = (["edge", "data", "app", "auth", "ci", "audit"] as const).flatMap((stack) =>
      Object.values(t[stack].findResources("AWS::Lambda::Function")).filter((f) => String(f.Properties.Runtime).startsWith("nodejs")),
    );
    // api, jobs, cron, cognito-email, and CDK's own providers (custom resources, cross-region exports).
    expect(fns.length).toBeGreaterThanOrEqual(5);
    for (const f of fns) expect(f.Properties.Runtime, String(f.Properties.FunctionName ?? f.Properties.Description)).toBe("nodejs24.x");
    expect(fns.map((f) => f.Properties.FunctionName).filter((name) => String(name).startsWith("insights-")).sort()).toEqual([
      "insights-production-api",
      "insights-production-cognito-email",
      "insights-production-cron",
      "insights-production-jobs",
    ]);
  });

  it("bundles the package for that Node", () => {
    expect(readFileSync(join(REPO_ROOT, "apps/aws/scripts/build.mjs"), "utf8")).toContain('target: "node24"');
  });
});

describe("the audit stack (Trusted Advisor security checks)", () => {
  it("logs every Region's management events, reads and writes, with digest files (AWS CloudTrail Management Events Logging)", () => {
    t.audit.resourceCountIs("AWS::CloudTrail::Trail", 1);
    t.audit.hasResourceProperties("AWS::CloudTrail::Trail", {
      IsMultiRegionTrail: true,
      IncludeGlobalServiceEvents: true,
      IsLogging: true,
      EnableLogFileValidation: true,
      EventSelectors: [{ IncludeManagementEvents: true, ReadWriteType: "All" }],
    });
  });

  it("keeps the logs in a private, versioned bucket for a year, retained if the stack goes", () => {
    t.audit.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      Properties: {
        PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
        VersioningConfiguration: { Status: "Enabled" },
        LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ ExpirationInDays: 365, NoncurrentVersionExpiration: { NoncurrentDays: 30 }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } })]) },
      },
    });
    t.audit.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: "Deny", Condition: { Bool: { "aws:SecureTransport": "false" } } })]) },
    });
  });

  it("lets CloudTrail use the bucket only for this trail, so no other account's trail can write to it", () => {
    t.audit.hasResourceProperties("AWS::CloudTrail::Trail", { TrailName: "insights-account" });
    const [policy] = Object.values(t.audit.findResources("AWS::S3::BucketPolicy"));
    type Statement = { Effect: string; Principal: unknown; Action: string; Condition?: unknown };
    const statements = (policy!.Properties.PolicyDocument.Statement as Statement[]).map(({ Effect, Principal, Action, Condition }) => ({ Effect, Principal, Action, Condition }));
    const trail = { "aws:SourceArn": "arn:aws:cloudtrail:ap-southeast-2:605411278365:trail/insights-account" };
    const cloudtrail = { Service: "cloudtrail.amazonaws.com" };
    expect(statements).toEqual([
      { Effect: "Deny", Principal: { AWS: "*" }, Action: "s3:*", Condition: { Bool: { "aws:SecureTransport": "false" } } },
      { Effect: "Allow", Principal: cloudtrail, Action: "s3:GetBucketAcl", Condition: { StringEquals: trail } },
      { Effect: "Allow", Principal: cloudtrail, Action: "s3:PutObject", Condition: { StringEquals: { "s3:x-amz-acl": "bucket-owner-full-control", ...trail } } },
    ]);
  });

  it("puts an account analyzer in every enabled Region, and fails the deploy if one can't be made (IAM Access Analyzer - external access)", () => {
    expect(ACCOUNT_REGIONS).toHaveLength(18);
    expect(ACCOUNT_REGIONS).toContain("ap-southeast-2");
    const [stackSet] = Object.values(t.audit.findResources("AWS::CloudFormation::StackSet"));
    expect(stackSet!.Properties.PermissionModel).toBe("SELF_MANAGED");
    expect(stackSet!.Properties.StackInstancesGroup).toEqual([{ DeploymentTargets: { Accounts: ["605411278365"] }, Regions: ACCOUNT_REGIONS }]);
    expect(stackSet!.Properties.OperationPreferences.FailureToleranceCount).toBe(0);
    const template = JSON.parse(stackSet!.Properties.TemplateBody);
    expect(Object.values(template.Resources)).toEqual([{ Type: "AWS::AccessAnalyzer::Analyzer", Properties: { AnalyzerName: ANALYZER_NAME, Type: "ACCOUNT" } }]);
    // The StackSet waits for the trail, so its new roles have had time to become usable.
    expect(stackSet!.DependsOn).toEqual([expect.stringMatching(/^Trail/)]);
  });

  it("lets only this account's StackSets use the administration role, and the execution role make only stacks and analyzers", () => {
    t.audit.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "insights-account-stackset-admin",
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: "cloudformation.amazonaws.com" },
            Condition: { StringEquals: { "aws:SourceAccount": "605411278365" }, ArnLike: { "aws:SourceArn": "arn:aws:cloudformation:*:605411278365:stackset/*" } },
          }),
        ]),
      },
    });
    type Statement = { Action: string | string[] };
    const [exec] = Object.values(t.audit.findResources("AWS::IAM::Role", { Properties: { RoleName: "insights-account-stackset-exec" } }));
    const actions = (exec!.Properties.Policies as Array<{ PolicyDocument: { Statement: Statement[] } }>).flatMap((p) => p.PolicyDocument.Statement.flatMap((s) => [s.Action].flat()));
    for (const action of actions) expect(action).toMatch(/^(cloudformation:\*|access-analyzer:\w+|organizations:List\w+|iam:CreateServiceLinkedRole)$/);
  });
});

describe("config", () => {
  it("carries the app's settings, without the addresses, Cognito ids or NODE_ENV", () => {
    const vars = appVars();
    expect(vars.SHOPIFY_API_KEY).toMatch(/^[0-9a-f]{32}$/);
    expect(vars.APP_URL).toBeUndefined();
    expect(vars.API_URL).toBeUndefined();
    expect(vars.NODE_ENV).toBeUndefined();
    expect(Object.keys(vars).some((k) => k.startsWith("COGNITO_"))).toBe(false);
    expect(JSON.parse(vars.SHOPIFY_EXTRA_APPS!)).toBeInstanceOf(Array);
  });
});
