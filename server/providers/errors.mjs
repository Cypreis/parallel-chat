// Errors shared by the providers.

// A tool input that could not be parsed at all. There is no valid tool_use
// block to answer, so the engine re-issues the round (it checks retryRound).
export class ToolInputParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolInputParseError";
    this.retryRound = true;
  }
}
