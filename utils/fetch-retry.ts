import { spawn } from "child_process";

const CURL_BIN = process.env.CURL_BIN || "curl";

async function curlFetch(
  url: string | URL,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  const args = ["-s", "-L"];
  for (const [key, value] of Object.entries(headers ?? {})) {
    args.push("-H", `${key}: ${value}`);
  }
  args.push(url.toString());

  const proc = spawn(CURL_BIN, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  proc.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  proc.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const abortHandler = () => proc.kill();
  if (signal) {
    signal.addEventListener("abort", abortHandler, { once: true });
  }

  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => resolve(code ?? 1));
  });

  if (signal) {
    signal.removeEventListener("abort", abortHandler);
  }

  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }

  if (exitCode !== 0) {
    throw new Error(`curl exited ${exitCode}: ${stderr}`);
  }
  return new Response(stdout, { status: 200 });
}

export async function fetchWithRetry<T = Response>(
  url: string | URL,
  params?: {
    options?: RequestInit;
    resolveWhen?: (res: Response) => Promise<T>;
    totalRetry?: number;
    retryBackOff?: (currentRetry: number) => number;
    _currentRetry?: number;
    useCurl?: boolean;
    abort?: AbortSignal;
  },
): Promise<T> {
  function sleep(millis: number) {
    return new Promise((r) => setTimeout(r, millis));
  }

  const _params = params ?? {};
  const retryTimes = _params.totalRetry ?? 3;
  const currentRetry = _params._currentRetry ?? 0;

  if (_params.abort?.aborted) return undefined as T;

  try {
    const res = _params.useCurl
      ? await curlFetch(url, _params.options?.headers as Record<string, string>, _params.abort)
      : await fetch(url, _params.options);
    if (!res.ok) {
      const obj = await res.text();
      throw Error(obj);
    }
    if (params?.resolveWhen) {
      return await params.resolveWhen(res);
    } else {
      return res as T;
    }
  } catch (e) {
    // do not retry on abort
    if (e instanceof DOMException && e.name === "AbortError")
      return undefined as T;

    // retry
    if (retryTimes - currentRetry <= 0) throw e;
    let delay: number;
    if (params?.retryBackOff) {
      delay = params.retryBackOff(currentRetry);
    } else {
      delay = 1000 * Math.pow(2, currentRetry);
    }
    if (_params.abort?.aborted) return undefined as T;
    await sleep(delay);
    return await fetchWithRetry(url, {
      ..._params,
      _currentRetry: currentRetry + 1,
    });
  }
}
