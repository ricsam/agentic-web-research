import type { AppConfig } from "../config";
import { Semaphore } from "../utils/semaphore";

export type ResearchRuntime = {
  researchTasks: Semaphore;
  pageRenders: Semaphore;
  retryAfterSeconds: number;
};

export function createResearchRuntime(config: AppConfig): ResearchRuntime {
  return {
    researchTasks: new Semaphore(config.MAX_ACTIVE_RESEARCH_TASKS),
    pageRenders: new Semaphore(config.MAX_ACTIVE_PAGE_RENDERS),
    retryAfterSeconds: config.CAPACITY_RETRY_AFTER_SECONDS
  };
}
