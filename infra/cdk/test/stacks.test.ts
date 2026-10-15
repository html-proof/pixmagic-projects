import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";

// A stand-in Lambda package, so the stacks synthesize without building the real one.
const fnDir = mkdtempSync(join(tmpdir(), "insights-fn-"));
writeFileSync(join(fnDir, "index.mjs"), "export const handler = async () => ({});\n");
process.env.INSIGHTS_FUNCTION_DIR = fnDir;

const { envConfig, stripJsonComments, appVars } = await import("../lib/config.js");
const { EdgeStack } = await import("../lib/edge-stack.js");
const { DataStack } = await import("../lib/data-stack.js");
const { AppStack } = await import("../lib/app-stack.js");
const { AuthStack } = await import("../lib/auth-stack.js");
const { CiStack } = await import("../lib/ci-stack.js");

function synth(context: Record<string, string> = {}) {
  const app = new App({ context });
  const cfg = envConfig((k) => app.node.tryGetContext(k));
  const env = { account: cfg.account, region: cfg.region };
  const edge = new EdgeStack(app, "E", cfg, { env: { account: cfg.account, region: "us-east-1" }, crossRegionReferences: true });
  const data = new DataStack(app, "D", cfg, { env });
  const appStack = new AppStack(app, "A", cfg, data, edge.webAclArn, { env, crossRegionReferences: true });
  const auth = new AuthStack(app, "U", cfg, { env, appUrl: "https://example.cloudfront.net", apiRole: appStack.apiRole, runtimeParam: appStack.runtimeParam });
  const ci = new CiStack(app, "C", cfg, { env });
  return { edge: Template.fromStack(edge), data: Template.fromStack(data), app: Template.fromStack(appStack), auth: Template.fromStack(auth), ci: Template.fromStack(ci) };
}

let t: ReturnType<typeof synth>;
beforeAll(() => {
  t = synth();
});

describe("the data stack", () => {
  it("keeps the database private, encrypted, backed up and protected", () => {
    t.data.hasResourceProperties("AWS::RDS::DBInstance", {
      PubliclyAccessible: false,
      StorageEncrypted: true,
      DeletionProtection: true,
      BackupRetentionPeriod: 14,
      MultiAZ: false,
      DBInstanceClass: "db.t4g.small",
      Engine: "postgres",
    });
    t.data.hasResource("AWS::RDS::DBInstance", { DeletionPolicy: "Snapshot" });
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

  it("blocks public access to both buckets and requires TLS", () => {
    const buckets = Object.values(t.data.findResources("AWS::S3::Bucket"));
    expect(buckets).toHaveLength(2);
    for (const b of buckets) {
      expect(b.Properties.PublicAccessBlockConfiguration).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
    }
    t.data.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: "Deny", Condition: { Bool: { "aws:SecureTransport": "false" } } })]) },
    });
  });

  it("has one NAT gateway (the lean tier) and no SSH key anywhere", () => {
    t.data.resourceCountIs("AWS::EC2::NatGateway", 1);
    t.data.hasResourceProperties("AWS::EC2::Instance", { KeyName: Match.absent() });
  });
});

describe("the app stack", () => {
  it("leaves the schedules off unless asked (no double syncs while Cloudflare still runs)", () => {
    const states = (tpl: Template) => Object.values(tpl.findResources("AWS::Scheduler::Schedule")).map((s) => s.Properties.State);
    expect(states(t.app)).toEqual(["DISABLED", "DISABLED"]);
    expect(states(synth({ schedules: "on" }).app)).toEqual(["ENABLED", "ENABLED"]);
  });

  it("gives every job queue a dead-letter queue and covers the jobs timeout", () => {
    const queues = Object.values(t.app.findResources("AWS::SQS::Queue")).filter((q) => q.Properties.RedrivePolicy);
    expect(queues).toHaveLength(4);
    for (const q of queues) {
      expect(q.Properties.RedrivePolicy.maxReceiveCount).toBe(10);
      expect(q.Properties.VisibilityTimeout).toBeGreaterThanOrEqual(900);
    }
    t.app.resourceCountIs("AWS::Lambda::EventSourceMapping", 4);
    t.app.allResourcesProperties("AWS::Lambda::EventSourceMapping", { FunctionResponseTypes: ["ReportBatchItemFailures"] });
  });

  it("runs the functions in the VPC, with secrets only by reference", () => {
    const fns = Object.values(t.app.findResources("AWS::Lambda::Function")).filter((f) => f.Properties.Handler === "index.handler");
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
        Origins: [Match.objectLike({ OriginCustomHeaders: [Match.objectLike({ HeaderName: "x-origin-verify" })] })],
      }),
    });
    expect(JSON.stringify(t.app.toJSON())).toMatch(/resolve:secretsmanager:.*ORIGIN_VERIFY/);
  });
});

describe("the edge stack", () => {
  it("rate-limits the API per IP and blocks known-bad traffic; the common rule set only counts", () => {
    const acl = Object.values(t.edge.findResources("AWS::WAFv2::WebACL"))[0]!.Properties;
    expect(acl.Scope).toBe("CLOUDFRONT");
    const rules = Object.fromEntries((acl.Rules as Array<{ Name: string }>).map((r) => [r.Name, r])) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(rules["api-rate-per-ip"].Statement.RateBasedStatement.Limit).toBe(300);
    expect(rules["aws-ip-reputation"].OverrideAction).toEqual({ None: {} });
    expect(rules["aws-common-count-only"].OverrideAction).toEqual({ Count: {} });
  });
});

describe("IAM", () => {
  it("has no IAM user or access key anywhere (roles only)", () => {
    for (const tpl of [t.ci, t.app, t.data]) {
      tpl.resourceCountIs("AWS::IAM::User", 0);
      tpl.resourceCountIs("AWS::IAM::AccessKey", 0);
    }
    // cognito.yaml keeps the Cloudflare Worker's IAM user behind a condition, false on AWS.
    const auth = t.auth.toJSON() as { Resources: Record<string, { Type: string; Condition?: string }>; Conditions: Record<string, unknown> };
    for (const r of Object.values(auth.Resources).filter((r) => r.Type === "AWS::IAM::User" || r.Type === "AWS::IAM::AccessKey")) {
      expect(r.Condition).toBe("HasWorkerUser");
    }
    expect(auth.Conditions.HasWorkerUser).toEqual({ "Fn::Equals": ["false", "true"] });
  });

  it("lets only this repository's production environment deploy from GitHub", () => {
    t.ci.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Condition: { StringEquals: { "token.actions.githubusercontent.com:sub": "repo:html-proof/pixmagic-projects:environment:production", "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" } },
          }),
        ],
      },
    });
  });
});

describe("config", () => {
  it("reads wrangler.jsonc's vars, without the addresses or Cognito ids", () => {
    const vars = appVars();
    expect(vars.SHOPIFY_API_KEY).toMatch(/^[0-9a-f]{32}$/);
    expect(vars.APP_URL).toBeUndefined();
    expect(Object.keys(vars).some((k) => k.startsWith("COGNITO_"))).toBe(false);
    expect(JSON.parse(vars.SHOPIFY_EXTRA_APPS!)).toBeInstanceOf(Array);
  });

  it("strips comments but not // inside strings", () => {
    expect(JSON.parse(stripJsonComments('{ "a": "https://x" /* c */, // d\n "b": 1, }'))).toEqual({ a: "https://x", b: 1 });
  });
});
