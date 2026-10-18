// Job-started hook of the PC's deploy-only runner (install-runner.ps1 -Deploy). The runner runs it
// with its own Node before every job, and any exit code but 0 fails the job before its first step.
// Only "Deploy to AWS" from main gets through: a job from any other workflow or branch could leave
// something behind (a tool, a package, a profile file) that the next deploy would run with while
// it holds the deploy role. Labels can't stop that: any branch's workflow can ask for any label.
// These values come from GitHub (the job's github context), not from the workflow file.
const allowed = {
  GITHUB_REPOSITORY_ID: "1413246051",
  GITHUB_WORKFLOW_REF: "html-proof/pixmagic-projects/.github/workflows/aws-deploy.yml@refs/heads/main",
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: ["workflow_run", "workflow_dispatch"],
};

const refused = Object.entries(allowed).filter(([name, want]) => ![want].flat().includes(process.env[name] ?? ""));
if (refused.length > 0) {
  for (const [name, want] of refused) {
    console.log(`::error::${name} is "${process.env[name] ?? ""}"; this runner takes only ${[want].flat().join(" or ")}.`);
  }
  console.log("::error::This runner runs only Deploy to AWS from main (docs/aws-deployment.md, the deploy-only runner).");
  process.exit(1);
}
console.log(`Deploy to AWS from main (${process.env.GITHUB_EVENT_NAME}, run ${process.env.GITHUB_RUN_ID}): allowed on this runner.`);
