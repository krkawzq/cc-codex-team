import { describe, expect, it } from "vitest";

import {
  JsonRpcError,
  RequestTimeoutError,
  RetryLimitExceededError,
  ServerBusyError,
  extractAdditionalDetails,
  extractCodexErrorInfo,
  isRetryable,
  mapJsonRpcError,
} from "../src/codex/errors";
import { retryOnOverload } from "../src/codex/retry";

describe("codex errors", () => {
  it("maps nested overloaded errors and retry-limit exhaustion", () => {
    const err = mapJsonRpcError(-32001, "retry limit exceeded", {
      codexErrorInfo: {
        activeTurnNotSteerable: "server_overloaded",
      },
      additionalDetails: "extra info",
    });

    expect(err).toBeInstanceOf(RetryLimitExceededError);
    expect(extractAdditionalDetails((err as JsonRpcError).data)).toBe("extra info");
  });

  it("extracts codex error info from camelCase and snake_case payloads", () => {
    expect(extractCodexErrorInfo({ codex_error_info: "server_overloaded" })).toBe("server_overloaded");
    expect(extractCodexErrorInfo({ codexErrorInfo: { type: "activeTurnNotSteerable" } })).toBe("active_turn_not_steerable");
    expect(extractCodexErrorInfo({ codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } } })).toBe("response_stream_disconnected");
  });

  it("marks only retryable overload errors as retryable", () => {
    expect(isRetryable(new ServerBusyError(-32001, "busy"))).toBe(true);
    expect(isRetryable(new RetryLimitExceededError(-32001, "retry limit exceeded"))).toBe(false);
    expect(isRetryable(new JsonRpcError(-32001, "other", { codex_error_info: "server_overloaded" }))).toBe(true);
    expect(isRetryable(new JsonRpcError(-32001, "stream gone", { codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } } }))).toBe(true);
    expect(isRetryable(new RequestTimeoutError("timed out"))).toBe(false);
    expect(isRetryable(new Error("nope"))).toBe(false);
  });
});

describe("retryOnOverload", () => {
  it("retries transient overload errors and eventually succeeds", async () => {
    let attempts = 0;

    const result = await retryOnOverload(async () => {
      attempts++;
      if (attempts < 3) {
        throw new ServerBusyError(-32001, "busy");
      }
      return "ok";
    }, {
      maxAttempts: 3,
      initialDelayMs: 0,
      maxDelayMs: 0,
      jitterRatio: 0,
    });

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("does not retry retry-limit-exceeded errors", async () => {
    let attempts = 0;

    await expect(retryOnOverload(async () => {
      attempts++;
      throw new RetryLimitExceededError(-32001, "retry limit exceeded");
    }, {
      maxAttempts: 3,
      initialDelayMs: 0,
      maxDelayMs: 0,
      jitterRatio: 0,
    })).rejects.toBeInstanceOf(RetryLimitExceededError);

    expect(attempts).toBe(1);
  });
});
