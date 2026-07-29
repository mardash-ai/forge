/**
 * `forge infra bootstrap` — the ONE verb allowed to create resources outside Terraform state,
 * because the state backend cannot store itself (plan §3.8). Idempotent by construction: every step
 * is check-then-create, so re-running it is the normal, expected usage.
 *
 * What it owns (and nothing else): the folder, the project, billing linkage, core API enablement,
 * the versioned state bucket, and — for foundation stacks that declare `github` — the Workload
 * Identity Federation pool + provider + deployer service account CI authenticates as. Everything
 * downstream of these lives in Terraform.
 *
 * NO SERVICE-ACCOUNT KEY IS EVER CREATED (§2.5 rule 3). Locally this runs as the operator's ADC;
 * in CI the deployer SA is assumed via WIF with short-lived tokens.
 */
import { run } from '../shared/exec';
import { capture } from './exec';
import { requireEnv, type RepoStack } from './config';

export interface BootstrapStep {
  name: string;
  status: 'exists' | 'created' | 'updated';
  detail?: string;
}

/** Side-effect gcloud call — merged output is fine for error reporting. */
async function gcloud(args: string[], opts: { allowFail?: boolean } = {}): Promise<{ code: number; output: string }> {
  const r = await run('gcloud', [...args, '--quiet'], { timeoutMs: 5 * 60 * 1000, tailLines: 100 });
  if ((r.code ?? 1) !== 0 && !opts.allowFail) {
    throw new Error(`gcloud ${args.slice(0, 4).join(' ')}… failed (exit ${r.code}):\n${r.combined.slice(-1500)}`);
  }
  return { code: r.code ?? 1, output: r.combined };
}

/**
 * Machine-READ gcloud call — STDOUT ONLY. The first live bootstrap parsed a stderr WARNING as a
 * folder id and handed it to `projects create --folder=…`; never parse merged streams.
 */
async function gcloudRead(args: string[]): Promise<{ code: number; stdout: string }> {
  const r = await capture('gcloud', [...args, '--quiet'], { timeoutMs: 5 * 60 * 1000 });
  return { code: r.code, stdout: r.stdout };
}

/** APIs every stack needs before terraform can manage resources in the project. */
const CORE_APIS = [
  'cloudresourcemanager.googleapis.com',
  'serviceusage.googleapis.com',
  'iam.googleapis.com',
  'iamcredentials.googleapis.com',
  'sts.googleapis.com',
  'compute.googleapis.com',
  'dns.googleapis.com',
  'run.googleapis.com',
  'sqladmin.googleapis.com',
  'servicenetworking.googleapis.com',
  'artifactregistry.googleapis.com',
  'secretmanager.googleapis.com',
  'certificatemanager.googleapis.com',
  'networksecurity.googleapis.com',
  'storage.googleapis.com',
  'monitoring.googleapis.com',
  'logging.googleapis.com',
];

/**
 * Roles the CI deployer holds on the project. A CURATED LIST, not roles/editor — reviewable here,
 * and the review is the point. Broad admin within the product's own project is the accepted scope;
 * nothing here grants anything outside it.
 */
export const DEPLOYER_ROLES = [
  'roles/run.admin',
  'roles/cloudsql.admin',
  'roles/compute.admin',
  'roles/dns.admin',
  'roles/artifactregistry.admin',
  'roles/secretmanager.admin',
  'roles/storage.admin',
  'roles/certificatemanager.owner',
  'roles/networksecurity.admin', // ServerTlsPolicy / mTLS — verified live: mtlsAdmin is NOT a real role
  'roles/servicenetworking.networksAdmin',
  'roles/iam.serviceAccountAdmin',
  'roles/iam.serviceAccountUser',
  'roles/resourcemanager.projectIamAdmin',
  'roles/monitoring.admin',
  'roles/logging.admin',
];

export const WIF_POOL_ID = 'github-ci';
export const WIF_PROVIDER_ID = 'github-oidc';

export function deployerSaEmail(projectId: string): string {
  return `forge-deployer@${projectId}.iam.gserviceaccount.com`;
}

export async function bootstrap(stack: RepoStack, env: string): Promise<BootstrapStep[]> {
  const cfg = stack.config;
  const e = requireEnv(cfg, env);
  const steps: BootstrapStep[] = [];
  const step = (name: string, status: BootstrapStep['status'], detail?: string) => {
    steps.push({ name, status, detail });
  };

  // ── 1. Folder (foundation-only, and only if declared) ──────────────────────────────
  let folderId: string | undefined;
  if (cfg.kind === 'foundation' && cfg.folder && cfg.org_id) {
    const list = await gcloudRead([
      'resource-manager', 'folders', 'list',
      `--organization=${cfg.org_id}`,
      `--filter=displayName=${cfg.folder}`,
      '--format=value(name)',
    ]);
    folderId = list.stdout.trim().split('\n').filter(Boolean)[0]?.replace('folders/', '');
    if (folderId && !/^\d+$/.test(folderId)) {
      throw new Error(`folder lookup returned a non-numeric id "${folderId}" — refusing to use it as a parent`);
    }
    if (folderId) {
      step(`folder "${cfg.folder}"`, 'exists', `folders/${folderId}`);
    } else {
      await gcloud([
        'resource-manager', 'folders', 'create',
        `--display-name=${cfg.folder}`,
        `--organization=${cfg.org_id}`,
      ]);
      // §3.7 in miniature: do NOT parse create's output (async operation + progress lines make it
      // junk) — re-READ the actual state. The first live bootstrap failed exactly here.
      const reread = await gcloudRead([
        'resource-manager', 'folders', 'list',
        `--organization=${cfg.org_id}`,
        `--filter=displayName=${cfg.folder}`,
        '--format=value(name)',
      ]);
      folderId = reread.stdout.trim().split('\n').filter(Boolean)[0]?.replace('folders/', '');
      if (!folderId || !/^\d+$/.test(folderId)) {
        throw new Error(`folder "${cfg.folder}" was created but could not be re-read — got "${folderId}"`);
      }
      step(`folder "${cfg.folder}"`, 'created', `folders/${folderId}`);
    }
  }

  // ── 2. Project ─────────────────────────────────────────────────────────────────────
  const exists = await gcloud(['projects', 'describe', e.project_id, '--format=value(projectId)'], { allowFail: true });
  if (exists.code === 0) {
    step(`project ${e.project_id}`, 'exists');
  } else {
    if (cfg.kind !== 'foundation') {
      throw new Error(
        `project ${e.project_id} does not exist. Projects are created by the FOUNDATION stack's bootstrap — ` +
          `run \`forge infra bootstrap --env ${env}\` in the foundation repo first.`,
      );
    }
    const parent = folderId ? [`--folder=${folderId}`] : cfg.org_id ? [`--organization=${cfg.org_id}`] : [];
    await gcloud(['projects', 'create', e.project_id, `--name=${e.project_id}`, ...parent]);
    step(`project ${e.project_id}`, 'created', folderId ? `under folders/${folderId}` : undefined);
  }

  // ── 3. Billing ─────────────────────────────────────────────────────────────────────
  if (cfg.kind === 'foundation' && cfg.billing_account) {
    const b = await gcloudRead(['billing', 'projects', 'describe', e.project_id, '--format=value(billingAccountName)']);
    if (b.stdout.includes(cfg.billing_account)) {
      step('billing link', 'exists', cfg.billing_account);
    } else {
      await gcloud(['billing', 'projects', 'link', e.project_id, `--billing-account=${cfg.billing_account}`]);
      step('billing link', 'created', cfg.billing_account);
    }
  }

  // ── 4. Core APIs (batch enable is idempotent) ──────────────────────────────────────
  await gcloud(['services', 'enable', ...CORE_APIS, `--project=${e.project_id}`]);
  step(`core APIs (${CORE_APIS.length})`, 'updated', 'services enable is idempotent');

  // ── 5. State bucket — versioned, uniform access, in the foundation project ─────────
  if (cfg.kind === 'foundation') {
    const bkt = await gcloud(['storage', 'buckets', 'describe', `gs://${cfg.state_bucket}`, '--format=value(name)'], {
      allowFail: true,
    });
    if (bkt.code === 0) {
      step(`state bucket gs://${cfg.state_bucket}`, 'exists');
    } else {
      await gcloud([
        'storage', 'buckets', 'create', `gs://${cfg.state_bucket}`,
        `--project=${e.project_id}`,
        `--location=${e.region}`,
        '--uniform-bucket-level-access',
      ]);
      await gcloud(['storage', 'buckets', 'update', `gs://${cfg.state_bucket}`, '--versioning']);
      step(`state bucket gs://${cfg.state_bucket}`, 'created', 'versioned, uniform access');
    }
  }

  // ── 6. WIF pool + provider + deployer SA (foundation with a github block) ──────────
  if (cfg.kind === 'foundation' && cfg.github) {
    const proj = e.project_id;
    const pool = await gcloud(
      ['iam', 'workload-identity-pools', 'describe', WIF_POOL_ID, `--project=${proj}`, '--location=global', '--format=value(name)'],
      { allowFail: true },
    );
    if (pool.code === 0) step(`WIF pool ${WIF_POOL_ID}`, 'exists');
    else {
      await gcloud([
        'iam', 'workload-identity-pools', 'create', WIF_POOL_ID,
        `--project=${proj}`, '--location=global', '--display-name=GitHub Actions CI',
      ]);
      step(`WIF pool ${WIF_POOL_ID}`, 'created');
    }

    const provider = await gcloud(
      ['iam', 'workload-identity-pools', 'providers', 'describe', WIF_PROVIDER_ID,
        `--project=${proj}`, '--location=global', `--workload-identity-pool=${WIF_POOL_ID}`, '--format=value(name)'],
      { allowFail: true },
    );
    if (provider.code === 0) step(`WIF provider ${WIF_PROVIDER_ID}`, 'exists');
    else {
      // Condition restricts federation to THIS github org — mandatory; an unconditioned provider
      // would let any GitHub repo on the planet mint tokens against the pool.
      await gcloud([
        'iam', 'workload-identity-pools', 'providers', 'create-oidc', WIF_PROVIDER_ID,
        `--project=${proj}`, '--location=global', `--workload-identity-pool=${WIF_POOL_ID}`,
        '--issuer-uri=https://token.actions.githubusercontent.com',
        '--attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner',
        `--attribute-condition=assertion.repository_owner=='${cfg.github.owner}'`,
        '--display-name=GitHub OIDC',
      ]);
      step(`WIF provider ${WIF_PROVIDER_ID}`, 'created', `locked to owner ${cfg.github.owner}`);
    }

    const sa = deployerSaEmail(proj);
    const saExists = await gcloud(['iam', 'service-accounts', 'describe', sa, `--project=${proj}`], { allowFail: true });
    if (saExists.code === 0) step(`deployer SA ${sa}`, 'exists');
    else {
      await gcloud(['iam', 'service-accounts', 'create', 'forge-deployer', `--project=${proj}`, '--display-name=forge infra CI deployer']);
      step(`deployer SA ${sa}`, 'created');
    }

    for (const role of DEPLOYER_ROLES) {
      await gcloud(['projects', 'add-iam-policy-binding', proj, `--member=serviceAccount:${sa}`, `--role=${role}`, '--condition=None']);
    }
    step(`deployer roles (${DEPLOYER_ROLES.length})`, 'updated', 'curated list in bootstrap.ts — NOT roles/editor');

    const projNumRead = await gcloudRead(['projects', 'describe', proj, '--format=value(projectNumber)']);
    const projNum = projNumRead.stdout.trim();
    if (!/^\d+$/.test(projNum)) throw new Error(`project number read failed — got "${projNum}"`);
    for (const repo of cfg.github.repos) {
      await gcloud([
        'iam', 'service-accounts', 'add-iam-policy-binding', sa, `--project=${proj}`,
        '--role=roles/iam.workloadIdentityUser',
        `--member=principalSet://iam.googleapis.com/projects/${projNum}/locations/global/workloadIdentityPools/${WIF_POOL_ID}/attribute.repository/${cfg.github.owner}/${repo}`,
      ]);
    }
    step(`WIF bindings (${cfg.github.repos.length} repos)`, 'updated', cfg.github.repos.join(', '));
  }

  return steps;
}
