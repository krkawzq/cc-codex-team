import { Config } from "./config";
import { EventBus } from "./eventBus";
import { RegistryStore } from "./registry";

export class CompactionMonitor {
  private readonly suggestedLevel = new Map<string, number>();

  constructor(
    private readonly cfg: Config,
    private readonly registry: RegistryStore,
    private readonly eventBus: EventBus,
  ) {
    void this.registry;
  }

  async observeUsage(
    name: string,
    usage: {
      contextTokensEstimate: number | null;
      modelContextWindow: number | null;
      cumulativeUsageTokens: number | null;
    },
  ): Promise<void> {
    const metric = usage.contextTokensEstimate ?? usage.cumulativeUsageTokens ?? 0;
    const threshold = this.cfg.compaction.thresholdTokens;
    if (metric < threshold) {
      return;
    }
    const level = Math.max(1, Math.floor(metric / threshold));
    const previousLevel = this.suggestedLevel.get(name) || 0;
    if (level <= previousLevel) {
      return;
    }
    this.suggestedLevel.set(name, level);
    this.eventBus.publish("events", {
      kind: "compact-suggest",
      session: name,
      tokens: metric,
      level,
      metric_kind: usage.contextTokensEstimate != null ? "context_estimate" : "cumulative_usage",
      context_tokens_estimate: usage.contextTokensEstimate,
      model_context_window: usage.modelContextWindow,
      cumulative_usage_tokens: usage.cumulativeUsageTokens,
      threshold,
    });
  }

  clear(name: string): void {
    this.suggestedLevel.delete(name);
  }
}
