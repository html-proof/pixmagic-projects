import { ArnFormat, CustomResource, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cr from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";
import type { EnvConfig } from "./config.js";

/** Invokes the cron function's "evolution-db-drop" action, and fails the deployment if it failed. */
const DB_DROP_CODE = `
const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");
exports.handler = async (event) => {
  if (event.RequestType === "Delete") return { PhysicalResourceId: event.PhysicalResourceId };
  const r = await new LambdaClient({}).send(new InvokeCommand({ FunctionName: process.env.TARGET, Payload: Buffer.from(JSON.stringify({ action: "evolution-db-drop" })) }));
  const body = r.Payload ? Buffer.from(r.Payload).toString("utf8") : "";
  if (r.FunctionError) throw new Error("evolution-db-drop failed: " + body.slice(0, 500));
  return { PhysicalResourceId: "evolution-db-drop", Data: { Result: body.slice(0, 200) } };
};
`;

/**
 * What is left of WhatsApp's Evolution API service (docs/whatsapp.md, "Removing Evolution"), release
 * 2 of removing it. WhatsApp runs on Meta's WhatsApp Business Platform only; the service, its ECS
 * cluster, task, Cloud Map namespace, security group and alarms left this template, so the deploy
 * that brings this version deletes them. The stack stays in the app (the deploy never destroys a
 * stack that leaves it) with one resource: a custom resource that drops the service's database and
 * role once (the cron's "evolution-db-drop" action), after the App stack has deployed the cron that
 * knows it. It imports nothing from the Data stack any more, which still exports what the previous
 * version of this stack imported until this update replaced it (data-stack.ts, release 3).
 *
 * Release 3 turns this into a placeholder and removes the drop action and the Data stack's leftovers.
 */
export class WhatsappStack extends Stack {
  constructor(scope: Construct, id: string, cfg: EnvConfig, props: StackProps) {
    super(scope, id, props);
    const prefix = `insights-${cfg.name}`;
    const cronArn = this.formatArn({ service: "lambda", resource: "function", resourceName: `${prefix}-cron:live`, arnFormat: ArnFormat.COLON_RESOURCE_NAME });
    const dropFn = new lambda.Function(this, "EvolutionDbDrop", {
      functionName: `${prefix}-evolution-db-drop`,
      description: "Insights WhatsApp: drops the retired Evolution API service's database (the cron's evolution-db-drop action) during the deploy that removes it",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromInline(DB_DROP_CODE),
      timeout: Duration.minutes(2),
      environment: { TARGET: cronArn },
      logGroup: new logs.LogGroup(this, "EvolutionDbDropLogs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
    });
    dropFn.addToRolePolicy(new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: [cronArn] }));
    const provider = new cr.Provider(this, "EvolutionDbDropProvider", { onEventHandler: dropFn, logGroup: new logs.LogGroup(this, "EvolutionDbDropProviderLogs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }) });
    // Once: a later deploy changes nothing here, so the custom resource isn't run again.
    new CustomResource(this, "EvolutionDbDropped", { serviceToken: provider.serviceToken, properties: { Version: "1" } });
  }
}
