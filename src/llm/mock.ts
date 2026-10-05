import type { ExplainInput, LlmClient } from "../types.ts";

export class MockLlmClient implements LlmClient {
  async translate(italian: string[]): Promise<string[]> {
    return italian.map((text) => `[mock translation] ${text}`);
  }

  async explain(input: ExplainInput): Promise<string> {
    return `[mock explanation] Reference: ${input.reference}`;
  }
}
