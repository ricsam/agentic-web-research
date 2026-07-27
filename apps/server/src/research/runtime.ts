import type { AppConfig } from "../config";
import { Semaphore } from "../utils/semaphore";
import { WebRenderer } from "./renderer";

export type ResearchRuntime = {
  researchTasks: Semaphore;
  pageRenders: Semaphore;
  renderer: WebRenderer;
  retryAfterSeconds: number;
};

export function createResearchRuntime(config: AppConfig): ResearchRuntime {
  return {
    researchTasks: new Semaphore(config.MAX_ACTIVE_RESEARCH_TASKS),
    pageRenders: new Semaphore(config.MAX_ACTIVE_PAGE_RENDERS),
    renderer: new WebRenderer(config.PLAYWRIGHT_HEADLESS),
    retryAfterSeconds: config.CAPACITY_RETRY_AFTER_SECONDS
  };
}
