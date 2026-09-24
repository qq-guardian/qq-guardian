import { existsSync, readFileSync } from 'node:fs';

export type HostOperatingSystem = 'windows' | 'linux' | 'android' | 'macos' | 'other';
export type DeploymentEnvironment = 'native' | 'docker' | 'wsl2' | 'termux';

export interface EnvironmentProbe {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  osRelease?: string;
  cgroup?: string;
  hasDockerMarker?: boolean;
}

export interface RuntimeEnvironment {
  operatingSystem: HostOperatingSystem;
  deployment: DeploymentEnvironment;
  isContainer: boolean;
  isWsl: boolean;
  isTermux: boolean;
}

function readOptional(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function hostOperatingSystem(platform: NodeJS.Platform): HostOperatingSystem {
  switch (platform) {
    case 'win32': return 'windows';
    case 'linux': return 'linux';
    case 'android': return 'android';
    case 'darwin': return 'macos';
    default: return 'other';
  }
}

/**
 * Detect the execution environment once at the platform boundary. Business
 * services should not inspect process.platform, Docker files, or WSL markers.
 */
export function detectRuntimeEnvironment(probe?: EnvironmentProbe): RuntimeEnvironment {
  // A supplied probe is a deterministic snapshot for tests and diagnostics.
  // Only the production no-argument path may read host-specific markers.
  const useHostDefaults = probe === undefined;
  const platform = probe?.platform ?? process.platform;
  const env = probe?.env ?? (useHostDefaults ? process.env : {});
  const operatingSystem = hostOperatingSystem(platform);
  const osRelease = probe?.osRelease ?? (useHostDefaults && platform === 'linux' ? readOptional('/proc/sys/kernel/osrelease') : '');
  const cgroup = probe?.cgroup ?? (useHostDefaults && platform === 'linux' ? readOptional('/proc/1/cgroup') : '');
  const hasDockerMarker = probe?.hasDockerMarker ?? (useHostDefaults && platform === 'linux' && existsSync('/.dockerenv'));
  const isTermux = Boolean(env['TERMUX_VERSION']) || Boolean(env['PREFIX']?.includes('/com.termux/'));
  const isWsl = platform === 'linux' && (
    Boolean(env['WSL_DISTRO_NAME'])
    || Boolean(env['WSL_INTEROP'])
    || /(?:microsoft|wsl)/i.test(osRelease)
  );
  const isContainer = Boolean(env['container'])
    || Boolean(env['CONTAINER'])
    || Boolean(env['DOCKER_CONTAINER'])
    || hasDockerMarker
    || /(?:docker|containerd|kubepods|podman)/i.test(cgroup);

  return {
    operatingSystem: isTermux ? 'android' : operatingSystem,
    deployment: isContainer ? 'docker' : isTermux ? 'termux' : isWsl ? 'wsl2' : 'native',
    isContainer,
    isWsl,
    isTermux,
  };
}

/** Containers need a routable listener for declared ports; native deployments
 * remain loopback-only unless the operator explicitly opts into exposure. */
export function defaultHttpHost(environment = detectRuntimeEnvironment()): string {
  return environment.isContainer ? '0.0.0.0' : '127.0.0.1';
}

export function readPort(value: string | undefined, fallback: number): number {
  return readBoundedInteger(value, fallback, 1, 65_535);
}

/** Parses an operator-supplied resource limit without accepting fractions or unsafe integers. */
export function readBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
