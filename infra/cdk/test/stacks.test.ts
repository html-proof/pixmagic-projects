import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
process.env.INSIGHTS_FUNCTION_DIR = fnDir;

const { envConfig, appVars } = await import("../lib/config.js");
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
  it("keeps the database private, encrypted, backed up and protected, with a standby in the other AZ", () => {
    t.data.hasResourceProperties("AWS::RDS::DBInstance", {
      PubliclyAccessible: false,
      StorageEncrypted: true,
      DeletionProtection: true,
      BackupRetentionPeriod: 14,
      MultiAZ: true,
      DBInstanceClass: "db.t4g.small",
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
});

describe("the app stack", () => {
  it("leaves the schedules off unless asked (no double syncs while the old deployment still runs)", () => {
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
    t.app.hasResourceProperties("AWS::SNS::TopicPolicy", {
      PolicyDocument: { Statement: [Match.objectLike({ Action: "sns:Publish", Principal: { Service: ["cloudwatch.amazonaws.com", "events.rds.amazonaws.com"] } })] },
    });
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
    expect(rules["api-rate-per-ip"].Statement.RateBasedStatement.Limit).toBe(300);
    expect(rules["api-rate-per-ip"].Statement.RateBasedStatement.AggregateKeyType).toBe("IP");
    expect(rules["aws-ip-reputation"].OverrideAction).toEqual({ None: {} });
    expect(rules["aws-common-count-only"].OverrideAction).toEqual({ Count: {} });
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
    expect(viaCloudflare.Limit).toBe(300);
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

describe("IAM", () => {
  it("has no IAM user or access key anywhere (roles only)", () => {
    for (const tpl of [t.ci, t.app, t.data, t.auth]) {
      tpl.resourceCountIs("AWS::IAM::User", 0);
      tpl.resourceCountIs("AWS::IAM::AccessKey", 0);
    }
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
