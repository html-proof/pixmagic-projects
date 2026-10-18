// Job-started hook of the PC's runner for main (install-runner.ps1 -Main). The runner runs it with
// its own Node before every job, and any exit code but 0 fails the job before its first step. Only
// main's own jobs get through: CI for a push to main, and Deploy to AWS from main. A job from any
// other workflow or branch (a pull request's) could leave something behind (a tool, a package, a
// profile file) that the next deploy would run with while it holds the deploy role. Labels can't
// stop that: any branch's workflow can ask for any label. These values come from GitHub (the job's
// github context), not from the workflow file.
const repo = "html-proof/pixmagic-projects";
const allowed = [
  { workflow: `${repo}/.github/workflows/ci.yml@refs/heads/main`, events: ["push"] },
  { workflow: `${repo}/.github/workflows/aws-deploy.yml@refs/heads/main`, events: ["workflow_run", "workflow_dispatch"] },
];

const env = process.env;
const ok =
  env.GITHUB_REPOSITORY_ID === "1413246051" &&
  env.GITHUB_REF === "refs/heads/main" &&
  allowed.some((a) => a.workflow === env.GITHUB_WORKFLOW_REF && a.events.includes(env.GITHUB_EVENT_NAME));
if (!ok) {
  console.log(
    `::error::This runner runs only main's jobs (docs/aws-deployment.md, the runner for main). This job: ${env.GITHUB_WORKFLOW_REF ?? "?"}, ` +
      `event ${env.GITHUB_EVENT_NAME ?? "?"}, ref ${env.GITHUB_REF ?? "?"}, repository id ${env.GITHUB_REPOSITORY_ID ?? "?"}.`,
  );
  for (const a of allowed) console.log(`Allowed: ${a.workflow} on ${a.events.join(" or ")} (repository id 1413246051).`);
  process.exit(1);
}
console.log(`${env.GITHUB_WORKFLOW_REF} (${env.GITHUB_EVENT_NAME}, run ${env.GITHUB_RUN_ID}): allowed on this runner.`);
