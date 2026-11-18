/**
 * ABOUTME: One self-run, through the same lifecycle as a managed run (`runInSandbox`): a fresh
 * container installs the host's agent version, the customer's credentials reach the agent, and
 * a completed run's artifacts are redacted together, once all are read, and written as its bundle.
 * The project is the test's starter, or the customer's repository at one commit. The egress IP
 * and image digest are read from the container before setup; sign-in files are written only once
 * setup has finished, just before the agent starts.
 */
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

import { sandboxArchitecture } from '../assets/architecture';
import { shellQuote } from '../assets/script';
import { redactArtifacts } from '../run/artifact-redaction';
import { AGENT_RUN_LIMITS } from '../run/limits';
import { piDirectBaseUrl, piProviderConfig, writePiConfig } from '../run/pi';
import {
  agentInvocation,
  judgeAgentExit,
  runInSandbox,
  type SandboxRunJob,
  type SandboxRunResult,
} from '../run/sandbox-run';
import { createTraceRedactor } from '../run/trace-redaction';
import type { DockerSandbox } from '../sandbox/docker';
import type { SandboxPlatform } from '../sandbox/platform';
import type { Sandbox, SandboxProvider } from '../sandbox/provider';
import { agentLastWords } from './agent-error';
import type { AgentPlan } from './agent-plan';
import type { ResolvedTest } from './args';
import {
  starterLockDigest,
  writeBundle,
  type BundleSetup,
  type WrittenBundle,
} from './bundle';
import type { AgentCredentials } from './credentials';
import { AgentEndpointError } from './errors';
import type { RepositorySnapshot } from './repository';

export interface SelfRunInput {
  test: ResolvedTest;
  /** The setup file the run came from, written beside the manifest's fields. */
  setup?: BundleSetup;
  plan: AgentPlan;
  credentials: AgentCredentials;
  /** The customer's repository at the commit to test, in place of the test's starter (`--repo`). */
  repository?: RepositorySnapshot;
  provider: SandboxProvider;
  outDir: string;
  runner: { name: '@devtune/agentpicks'; version: string };
  host: { os: string; arch: string };
  /** The Docker host's platform, which the sandbox runs natively. */
  platform: SandboxPlatform;
  /** Progress for the person running it. */
  log: (line: string) => void;
}

export interface SelfRunOutcome {
  runId: string;
  run: SandboxRunResult;
  /** Written only for a run that completed. */
  bundle: WrittenBundle | null;
  /** For a run that failed at the agent, why it stopped (`agentLastWords`); empty otherwise. */
  agentError: string[];
}

/** Where the egress IP is read from: a single request whose only answer is the caller's address. */
export const EGRESS_IP_URL = 'https://api.ipify.org';

export async function selfRun(input: SelfRunInput): Promise<SelfRunOutcome> {
  const { test, plan, credentials, repository, log } = input;
  const runId = randomUUID();
  const job: SandboxRunJob = {
    id: runId,
    environment: test.environment,
    signals: { earlyStop: test.category.earlyStop },
    agent: plan.agent.kind,
    model: plan.model,
    prompt: test.prompt,
    agentVersion: plan.agent.version,
    ...(repository
      ? {
          repository: {
            packed: repository.packed,
            install: repository.install,
          },
        }
      : {}),
    architecture: sandboxArchitecture(input.platform),
    ...(AGENT_RUN_LIMITS[plan.agent.kind].earlyStopGraceSec !== null
      ? {
          earlyStopGraceSec:
            AGENT_RUN_LIMITS[plan.agent.kind].earlyStopGraceSec!,
        }
      : {}),
  };
  const redactMessage = createTraceRedactor(
    Object.fromEntries(
      credentials.secrets.map((value, i) => [`secret${i}`, value]),
    ),
    { names: false },
  );
  const context = { imageDigest: '', egressIp: null as string | null };

  const run = await runInSandbox(job, input.provider, {
    configure: () => credentials.env,
    // Artifacts are redacted together after the run (`redactArtifacts`), since a secret the
    // agent wrote is found by reading all of them; errors and output are redacted here.
    redact: (text, artifact) => (artifact ? text : redactMessage(text)),
    async afterUpload(box) {
      context.egressIp = await readEgressIp(box);
      for (const endpoint of credentials.endpoints) {
        const result = await box.exec(
          `curl --noproxy '*' --globoff --head --silent --show-error --output /dev/null --max-time 10 --url ${shellQuote(new URL(endpoint.url).origin)}`,
          { timeoutSec: 15 },
        );
        if (result.exitCode !== 0) {
          const reasons: Record<number, string> = {
            6: `could not resolve ${new URL(endpoint.url).hostname}`,
            7: 'could not connect',
            28: 'no answer in 10 s',
            35: 'TLS handshake failed',
            60: 'TLS certificate verification failed',
          };
          const reason =
            reasons[result.exitCode] ??
            (result.stderr.trim().replace(/^curl: \(\d+\)\s*/, '') ||
              `curl exit ${result.exitCode}`);
          const advice =
            result.exitCode === 6
              ? 'Names only your network knows (a LAN, mDNS .local or Tailscale MagicDNS name) may not resolve inside the sandbox: use its IP address instead, and check the sandbox can reach that address.'
              : result.exitCode === 35 || result.exitCode === 60
                ? 'Use a certificate from a publicly trusted CA, or plain HTTP on your network, then try again.'
                : 'Check that the server is running, listens on an address other than 127.0.0.1, and that no firewall blocks the sandbox, then try again.';
          throw new AgentEndpointError(
            `${plan.agent.name}'s ${endpoint.name} (${endpoint.source}) is ${endpoint.url}, and the sandbox can't reach it: ${reason}. ${advice}`,
          );
        }
      }
      context.imageDigest = isDockerSandbox(box) ? await box.imageDigest() : '';
      log(
        `  Setting up ${repository ? 'your repository' : test.environment.slug} with ${plan.agent.name} ${plan.agent.version}…`,
      );
    },
    async beforeAgent(box) {
      for (const file of credentials.files) {
        await box.writeFile(file.path, file.content);
        const chmod = await box.exec(`chmod 600 ${shellQuote(file.path)}`);
        if (chmod.exitCode !== 0)
          throw new Error(
            `restricting ${file.path} failed: ${chmod.stderr.trim()}`,
          );
      }
      if (plan.agent.kind === 'pi' && plan.provider)
        await writePiConfig(
          box,
          piProviderConfig({
            provider: plan.provider,
            model: plan.model,
            baseUrl: piDirectBaseUrl(plan.provider),
            apiKeyEnv:
              plan.provider === 'anthropic'
                ? 'ANTHROPIC_API_KEY'
                : 'OPENAI_API_KEY',
            authHeader: false,
            reasoning: true,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          }),
        );
      log(`  Running ${plan.agent.name}…`);
    },
    invocation: (keyEnv) => agentInvocation(job, keyEnv, plan.modelArg),
    judge: (artifacts) => judgeAgentExit(plan.agent.kind, artifacts),
  });

  const { artifacts, counts, redact } = redactArtifacts(
    run.artifacts,
    credentials.secrets,
  );
  // The run's messages were redacted with the credentials as they arrived; mask the secrets
  // its artifacts show it wrote too. A failed run's artifacts are dropped once they say why the
  // agent stopped.
  const messages = {
    error: run.error && redact(run.error),
    agentTail: run.agentTail && redact(run.agentTail),
    destroyError: run.destroyError && redact(run.destroyError),
  };
  if (run.status !== 'ok')
    return {
      runId,
      run: { ...run, ...messages, artifacts: {} },
      bundle: null,
      agentError:
        run.failedStage === 'agent' ? agentLastWords(artifacts, redact) : [],
    };
  const bundle = await writeBundle({
    outDir: input.outDir,
    manifest: {
      runId,
      runner: input.runner,
      agent: {
        kind: plan.agent.kind,
        version: plan.agent.version,
        model: plan.agent.model,
      },
      host: input.host,
      sandbox: {
        provider: 'docker',
        imageDigest: context.imageDigest,
        egressIp: context.egressIp,
      },
      ...(repository
        ? {
            repository: {
              remoteUrl: repository.remoteUrl,
              commit: repository.commit,
            },
          }
        : {
            stack: {
              slug: test.environment.slug,
              starter: test.environment.starter,
              lockDigest: starterLockDigest(test.environment.starter),
            },
          }),
      request: {
        category: test.category.slug,
        intent: test.intent,
        prompt: run.promptText,
      },
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    },
    setup: input.setup,
    earlyStop: test.category.earlyStop,
    artifacts,
    counts,
  });
  return {
    runId,
    run: { ...run, ...messages, artifacts },
    bundle,
    agentError: [],
  };
}

/**
 * The container's public address, from one HTTPS request made inside it before setup; null when
 * it can't be read, which never fails the run.
 */
export async function readEgressIp(box: Sandbox): Promise<string | null> {
  try {
    const r = await box.exec(`curl -fsS --max-time 10 ${EGRESS_IP_URL}`, {
      timeoutSec: 20,
    });
    const ip = r.stdout.trim();
    return r.exitCode === 0 && isIP(ip) !== 0 ? ip : null;
  } catch {
    // The exec itself failed (a docker error); the address stays unknown.
    return null;
  }
}

function isDockerSandbox(box: Sandbox): box is DockerSandbox {
  return 'imageDigest' in box && typeof box.imageDigest === 'function';
}
