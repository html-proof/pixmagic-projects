import { DefaultStackSynthesizer, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cr from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";

/**
 * S3 server access logs (Trusted Advisor "Amazon S3 Server Access Logs Enabled"): S3 writes a
 * line for every request to a bucket (who, what, when, from where, the result) into a log bucket
 * of the same Region, under `<source bucket>/`. Delivery is free; the files cost their storage
 * (cents: a few thousand requests a day) and are kept ACCESS_LOG_DAYS.
 *
 * The log bucket itself can't be logged: S3 says a destination bucket should not have logging on
 * (its own deliveries would log each other without end). Trusted Advisor lists it all the same,
 * so that one row is excluded there (docs/aws-deployment.md, Security checks).
 */

/** How long a log file is kept. */
export const ACCESS_LOG_DAYS = 90;

/** The bucket `cdk bootstrap` made in a Region for CDK's own uploads (templates, function packages). */
export function bootstrapAssetsBucket(account: string, region: string): string {
  return `cdk-${DefaultStackSynthesizer.DEFAULT_QUALIFIER}-assets-${account}-${region}`;
}

/**
 * A Region's log bucket. S3's logging service may write to it from this account's buckets only
 * (`aws:SourceAccount`): each source bucket's own grant would be a cross-stack reference back into
 * this stack, so one grant covers them all. S3's own keys, as log delivery requires (with a KMS
 * key S3 may deliver files encrypted under a key nobody can read).
 */
export function accessLogBucket(scope: Construct, id: string, bucketName: string): s3.Bucket {
  const bucket = new s3.Bucket(scope, id, {
    bucketName,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    // Versioned like every bucket (Trusted Advisor "S3 Bucket Versioning"); log files are never
    // overwritten, so an old version only ever comes from a deletion, and goes the next day.
    versioned: true,
    lifecycleRules: [
      { expiration: Duration.days(ACCESS_LOG_DAYS), noncurrentVersionExpiration: Duration.days(1), abortIncompleteMultipartUploadAfter: Duration.days(1) },
      { expiredObjectDeleteMarker: true },
    ],
    removalPolicy: RemovalPolicy.RETAIN,
  });
  bucket.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: "S3ServerAccessLogsPolicy",
      principals: [new iam.ServicePrincipal("logging.s3.amazonaws.com")],
      actions: ["s3:PutObject"],
      resources: [bucket.arnForObjects("*")],
      conditions: { StringEquals: { "aws:SourceAccount": Stack.of(scope).account } },
    }),
  );
  return bucket;
}

/**
 * The name and logging of a bucket that logs to `target`, under `<name>/`. `target` is the log
 * bucket by reference (`s3.Bucket.fromBucketName`), not the Bucket: given the Bucket, CDK adds a
 * grant per source to its policy, unconditioned when the source is in another stack.
 */
export function loggedBucket(name: string, target: s3.IBucket): Pick<s3.BucketProps, "bucketName" | "serverAccessLogsBucket" | "serverAccessLogsPrefix"> {
  return { bucketName: name, serverAccessLogsBucket: target, serverAccessLogsPrefix: `${name}/` };
}

/**
 * Turns on access logging, to `target`, for a bucket no stack owns (the one `cdk bootstrap` made
 * in the Region): CloudFormation can't set a property of a resource it doesn't manage, so a custom
 * resource calls S3 directly. Removing it turns the logging off again.
 */
export function logBucketAccess(scope: Construct, id: string, props: { bucketName: string; target: s3.IBucket; logGroup: logs.ILogGroup }): cr.AwsCustomResource {
  const call = (enabled: boolean): cr.AwsSdkCall => ({
    service: "S3",
    action: "putBucketLogging",
    parameters: {
      Bucket: props.bucketName,
      BucketLoggingStatus: enabled ? { LoggingEnabled: { TargetBucket: props.target.bucketName, TargetPrefix: `${props.bucketName}/` } } : {},
    },
    physicalResourceId: cr.PhysicalResourceId.of(`${props.bucketName}/access-logs`),
    ...(enabled ? {} : { ignoreErrorCodesMatching: "NoSuchBucket" }),
  });
  return new cr.AwsCustomResource(scope, id, {
    onCreate: call(true),
    onUpdate: call(true),
    onDelete: call(false),
    installLatestAwsSdk: false,
    logGroup: props.logGroup,
    policy: cr.AwsCustomResourcePolicy.fromStatements([new iam.PolicyStatement({ actions: ["s3:PutBucketLogging"], resources: [`arn:aws:s3:::${props.bucketName}`] })]),
  });
}
