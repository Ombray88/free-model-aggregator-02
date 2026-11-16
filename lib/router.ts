import type { Brief, ModelRow, Requirement } from './providers.ts';
import { freeModels, meetsRequirements, capabilitiesOf } from './providers.ts';

export type { Requirement };

export interface PlannedModel {
  providerId: string;
  modelId: string;
  wire: 'openai';
  baseUrl: string;
  key: string;
  auth: string;
  rating: number;
  tools: boolean | null;
  vision: boolean | null;
  json: boolean | null;
  contextLength: number | null;
}

export class Router {
  private brief: Brief;
  private freeList: ModelRow[];
  private tried: Map<string, Set<string>> = new Map();
  private cooldowns: Set<string> = new Set();
  public calls = 0;

  constructor(brief: Brief, _probes?: unknown) {
    this.brief = brief;
    this.freeList = [...freeModels(brief)].sort((a, b) => {
      if (b.rating_milli !== a.rating_milli) {
        return b.rating_milli - a.rating_milli;
      }
      return a.id.localeCompare(b.id);
    });
  }

  plan(_manifest: readonly { id: string; requires?: Requirement }[]): void {
    this.tried.clear();
    this.cooldowns.clear();
    this.calls = 0;
  }

  nextCandidate(requestId: string, req?: Requirement): PlannedModel | null {
    let requirement: Requirement = req ?? {};
    if (!req && this.brief.prompts) {
      const p = this.brief.prompts.find((pr) => pr.id === requestId);
      if (p) requirement = p.requires;
    }

    let triedSet = this.tried.get(requestId);
    if (!triedSet) {
      triedSet = new Set<string>();
      this.tried.set(requestId, triedSet);
    }

    for (const model of this.freeList) {
      if (triedSet.has(model.id)) continue;
      if (this.cooldowns.has(model.id)) continue;
      if (!meetsRequirements(requirement, capabilitiesOf(model))) continue;

      triedSet.add(model.id);
      this.calls++;
      return {
        providerId: model.provider || 'openrouter',
        modelId: model.id,
        wire: 'openai',
        baseUrl: 'https://openrouter.ai/api/v1',
        key: process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
        auth: 'bearer',
        rating: model.rating_milli,
        tools: model.tools,
        vision: model.vision,
        json: model.json,
        contextLength: model.context_length,
      };
    }
    return null;
  }

  noteSuccess(modelId: string): void {
    this.cooldowns.delete(modelId);
  }

  noteFailure(modelId: string, _failureText: string): void {
    this.cooldowns.add(modelId);
  }
}
