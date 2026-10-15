import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";

// A stand-in Lambda package, so the stacks synthesize without building the real one.
const fnDir = mkdtempSync(join(tmpdir(), "insights-fn-"));
writeFileSync(join(fnDir, "index.mjs"), "export const handler = async () => ({});\n");
mkdirSync(join(fnDir, "public/_next/static/chunks"), { recursive: true });
writeFileSync(join(fnDir, "public/_next/static/chunks/main.js"), "void 0;\n");
process.env.INSIGHTS_FUNCTION_DIR = fnDir;

const { envConfig, stripJsonComments, appVars } = await import("../lib/config.js");
const { EdgeStack } = await import("../lib/edge-stack.js");
const { DataStack } = await import("../lib/data-stack.js");
const { AppStack } = await import("../lib/app-stack.js");
const { AuthStack } = await import("../lib/auth-stack.js");
const { CiStack } = await import("../lib/ci-stack.js");
const { viewerRequestCode } = await import("../lib/viewer-request.js");

function synth(context: Record<string, string> = {}) {
  const app = new App({ context });
  const cfg = envConfig((k) => app.node.tryGetContext(k));
  const env = { account: cfg.account, region: cfg.region };
  const edge = new EdgeStack(app, "E", cfg, { env: { account: cfg.account, region: "us-east-1" }, crossRegionReferences: true });
  const data = new DataStack(app, "D", cfg, { env });
  const appStack = new AppStack(app, "A", cfg, data, edge.webAclArn, { env, crossRegionReferences: true });
  const auth = new AuthStack(app, "U", cfg, { env, appUrl: appStack.appUrl, apiRole: appStack.apiRole, runtimeParam: appStack.runtimeParam });
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
    const dist = Object.values(t.app.findResources("AWS::CloudFront::Distribution"))[0]!.Properties.DistributionConfig;
    const byId = Object.fromEntries((dist.Origins as Array<{ Id: string }>).map((o) => [o.Id, o])) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const assets = (dist.CacheBehaviors as Array<{ PathPattern: string; TargetOriginId: string }>).find((b) => b.PathPattern === "/_next/static/*")!;
    expect(byId[assets.TargetOriginId].S3OriginConfig).toBeDefined();
    expect(byId[assets.TargetOriginId].OriginAccessControlId).toBeDefined();
    expect(byId[assets.TargetOriginId].OriginCustomHeaders).toBeUndefined();
    expect(byId[dist.DefaultCacheBehavior.TargetOriginId].OriginCustomHeaders).toBeDefined();

    const site = Object.values(t.app.findResources("AWS::S3::Bucket"));
    expect(site).toHaveLength(1);
    expect(site[0]!.Properties.PublicAccessBlockConfiguration).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
    t.app.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: "Allow", Principal: { Service: "cloudfront.amazonaws.com" }, Action: ["s3:GetObject", "s3:ListBucket"] })]) },
    });
    // Old builds' chunks stay for pages still open; fonts get their type (the upload's CLI can't tell).
    const uploads = Object.values(t.app.findResources("Custom::CDKBucketDeployment")).map((r) => r.Properties);
    expect(uploads).toHaveLength(2);
    for (const u of uploads) {
      expect(u).toMatchObject({ Prune: false, DestinationBucketKeyPrefix: "_next/static/", SystemMetadata: { "cache-control": "public, max-age=31536000, immutable" } });
    }
    expect(uploads.find((u) => u.Include)).toMatchObject({ Include: ["*.woff2"], SystemMetadata: { "content-type": "font/woff2" } });
    expect(uploads.find((u) => !u.Include)).toMatchObject({ Exclude: ["*.woff2"] });
    // CloudFront and the API's live alias wait for both uploads.
    const resources = t.app.toJSON().Resources as Record<string, { Type: string; DependsOn?: string[] }>;
    const ids = Object.keys(resources).filter((id) => resources[id]!.Type === "Custom::CDKBucketDeployment");
    const waiting = (type: string) => Object.values(resources).filter((r) => r.Type === type && ids.every((id) => r.DependsOn?.includes(id))).length;
    expect(waiting("AWS::CloudFront::Distribution")).toBe(1);
    expect(waiting("AWS::Lambda::Alias")).toBe(1);
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
    const dist = Object.values(staging.app.findResources("AWS::CloudFront::Distribution"))[0]!.Properties.DistributionConfig;
    expect(dist.Aliases).toBeUndefined();
    expect(dist.ViewerCertificate).toBeUndefined();
    for (const f of Object.values(staging.app.findResources("AWS::Lambda::Function")).filter((f) => f.Properties.Handler === "index.handler" && String(f.Properties.Runtime).startsWith("nodejs"))) {
      expect(f.Properties.Environment.Variables.APP_URL).toBeUndefined();
    }
  });
});

describe("the viewer-request function", () => {
  type Req = { method: string; uri: string; querystring: Record<string, { value: string; multiValue?: Array<{ value: string }> }>; headers: Record<string, { value: string }> };
  const run = (canonical: string | undefined, req: Partial<Req>) => {
    const handler = new Function(`${viewerRequestCode(canonical)}
return handler;`)() as (e: unknown) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
    return handler({ viewer: { ip: "203.0.113.9" }, request: { method: "GET", uri: "/", querystring: {}, headers: {}, ...req } });
  };

  it("passes the viewer's address and host on, over anything the client sent", () => {
    const r = run("bizinsights.io", { headers: { host: { value: "bizinsights.io" }, "x-insights-viewer-ip": { value: "1.2.3.4" } } });
    expect(r.headers["x-insights-viewer-ip"]).toEqual({ value: "203.0.113.9" });
    expect(r.headers["x-insights-viewer-host"]).toEqual({ value: "bizinsights.io" });
    expect(r.statusCode).toBeUndefined();
  });

  it("sends page requests on other names to the domain, path and query exactly as received", () => {
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
    expect(code).not.toMatch(/(import|require)/);
    expect(code.length).toBeLessThan(10_240);
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
    // The immutable subject GitHub sends for this repository (owner and repository ids), not the bare name.
    t.ci.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Condition: {
              StringEquals: {
                "token.actions.githubusercontent.com:sub": "repo:html-proof@68529971/pixmagic-projects@1413246051:environment:production",
                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
              },
            },
          }),
        ],
      },
    });
  });

  it("lets the deploy role read everything the workflow's smoke tests check", () => {
    type Policy = { Properties: { PolicyDocument: { Statement: Array<{ Action: string | string[] }> } } };
    const actions = Object.values(t.ci.findResources("AWS::IAM::Policy")).flatMap((p) => (p as Policy).Properties.PolicyDocument.Statement.flatMap((s) => [s.Action].flat()));
    for (const needed of ["rds:DescribeDBInstances", "s3:GetBucketPublicAccessBlock", "sqs:GetQueueUrl", "sqs:GetQueueAttributes", "logs:DescribeLogStreams", "cloudwatch:GetMetricStatistics", "lambda:GetAlias"]) {
      expect(actions).toContain(needed);
    }
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
