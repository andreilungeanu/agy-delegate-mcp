// Everything describing the turn in progress, reset as one before the prompt. freshFields() is the
// single declaration reset() applies, so a field added there is reset too.

const RECOMMENDED = /^\(Recommended\)\s*/;

const isTerminalToolStatus = (status) =>
  status === "completed" || status === "failed" || status === "cancelled";

// Each stream reports its newest complete sentence, at most one per throttle window.
// Capital-letter boundary: an agent can stream sentences with no separator between them.
const SENTENCE_END = /[.!?](?=\s|[A-Z])|\n/;
const MARKDOWN_LINE = /^(?:[|#>`~*_=+-]|\d+[.)]\s)/;
/**
 * @param {string} prefix
 * @param {((message: string) => void) | undefined} onProgress
 * @param {number} throttleMs
 */
function progressStream(prefix, onProgress, throttleMs) {
  let buf = "", pending = null, lastEmit = 0;
  const flush = (force) => {
    if (pending === null || (!force && Date.now() - lastEmit < throttleMs)) return;
    lastEmit = Date.now();
    try { onProgress?.(prefix + pending); } catch {}
    pending = null;
  };
  const take = (s) => {
    const line = s.replace(/\s+/g, " ").trim().slice(0, 200);
    if (line.length > 3 && !MARKDOWN_LINE.test(line)) pending = line;
    flush(false);
  };
  return {
    push(text) {
      buf += text;
      for (let m; (m = SENTENCE_END.exec(buf)); buf = buf.slice(m.index + 1)) {
        take(buf.slice(0, m.index + 1));
      }
      if (buf.length > 300) { take(buf); buf = ""; }
    },
    end() { take(buf); buf = ""; flush(true); },
    reset() { buf = ""; pending = null; },
  };
}

// The single declaration of what a turn accumulates.
function freshFields() {
  return {
    resultChunks: [],
    // Text a later tool call superseded: usually a preamble, but it can be the whole answer when
    // agy replies and then runs one more command. Handed back, labelled, only when nothing else is.
    discardedResult: "",
    // Message text sent since a still-running tool call started; handed back only when the turn
    // ends with the call unfinished (a backgrounded command or ask_question).
    unfinishedToolText: "",
    sawToolCall: false,
    collectingPostToolResult: false,
    activeToolCalls: new Set(),
    // Tool name per call id, to tell an ask_question (waits on the caller) from a backgrounded
    // command (finishes by itself).
    toolNames: new Map(),
    // The one-line label per call id, so a warning names the call still open, not the newest one.
    toolLabels: new Map(),
    // Set by a usage_update, cleared by any other frame: agy closes a completed turn, prompted or
    // not, with one.
    usageAfterActivity: false,
    // The newest usage_update's { used, size }; unlike the reply's usage it covers a continuation.
    contextUsage: undefined,
    lastFrameAt: 0,
    // Ids seen terminal, so a stale non-terminal re-send cannot discard a collected final message.
    finishedToolCalls: new Set(),
    // agy's artifacts (the plan): write_file calls carrying ArtifactMetadata, under
    // ~/.gemini/antigravity-cli/brain/<sessionId>/. Keyed by path, so a rewrite replaces.
    artifacts: new Map(),
    touched: new Set(),
    // One record per tool call, in first-seen order, for the execution summary: agy re-sends
    // finished calls, so their frames merge.
    toolCallRecords: new Map(),
    // The questions of each ask_question call, normalized, by call id.
    questions: new Map(),
    lastToolLabel: null,
    sessionTitle: undefined,
  };
}

/**
 * @param {{ onProgress?: (message: string) => void, progressThrottleMs?: number }} [opts]
 */
export function makeTurnState({ onProgress, progressThrottleMs = 2000 } = {}) {
  const state = {
    ...freshFields(),
    thoughts: progressStream("thinking: ", onProgress, progressThrottleMs),
    messages: progressStream("agy: ", onProgress, progressThrottleMs),

    reset() {
      Object.assign(state, freshFields());
      state.thoughts.reset();
      state.messages.reset();
    },

    text() {
      return state.resultChunks.join("");
    },

    resetResult() {
      if (state.resultChunks.length > 0) state.discardedResult = state.resultChunks.join("");
      state.resultChunks.length = 0;
    },

    // Uncapped: a cap would return a partial answer as the whole one.
    appendResult(text) {
      state.resultChunks.push(text);
    },

    startTool(toolCallId, status, name) {
      if (toolCallId != null && name) state.toolNames.set(toolCallId, String(name));
      state.unfinishedToolText = "";
      state.sawToolCall = true;
      state.collectingPostToolResult = false;
      state.resetResult();
      if (toolCallId != null && !isTerminalToolStatus(status)) {
        state.activeToolCalls.add(toolCallId);
        // A fresh tool_call frame for a finished id is the agent reusing it, not history.
        state.finishedToolCalls.delete(toolCallId);
      }
      if (toolCallId != null && isTerminalToolStatus(status)) state.finishedToolCalls.add(toolCallId);
      if (isTerminalToolStatus(status) && state.activeToolCalls.size === 0) state.collectingPostToolResult = true;
    },

    updateToolStatus(toolCallId, status) {
      if (!status) return;
      if (toolCallId != null && !isTerminalToolStatus(status) && state.finishedToolCalls.has(toolCallId)) return;
      if (!state.sawToolCall) {
        state.sawToolCall = true;
        state.resetResult();
      }
      if (isTerminalToolStatus(status)) {
        if (toolCallId != null) {
          state.activeToolCalls.delete(toolCallId);
          state.finishedToolCalls.add(toolCallId);
        }
        if (state.activeToolCalls.size === 0 && !state.collectingPostToolResult) {
          // Drop text sent while tools ran; the guard above keeps a late duplicate from wiping a
          // collected final message.
          state.resetResult();
          state.collectingPostToolResult = true;
        }
      } else {
        state.collectingPostToolResult = false;
        state.resetResult();
        if (toolCallId != null) state.activeToolCalls.add(toolCallId);
      }
    },

    // Unfinished calls that end on their own: a backgrounded command or a scheduled wake-up. An
    // ask_question waits on the caller instead, so it is never waited for.
    backgroundToolCalls() {
      return [...state.activeToolCalls].filter((id) => !state.isQuestion(id));
    },

    isQuestion(id) {
      return /ask_question/.test(state.toolNames.get(id) ?? "");
    },

    // agy sends rawInput.questions as [{question, options[], is_multi_select}], marking one option
    // "(Recommended) ". Entries without a question string are dropped; false when none is left.
    recordQuestions(id, raw) {
      if (id == null || !Array.isArray(raw)) return false;
      const questions = raw.filter((q) => q && typeof q.question === "string" && q.question).map((q) => {
        const options = (Array.isArray(q.options) ? q.options : []).filter((o) => typeof o === "string");
        const marked = options.find((o) => RECOMMENDED.test(o));
        return {
          question: q.question,
          options: options.map((o) => o.replace(RECOMMENDED, "")),
          ...(q.is_multi_select === true ? { multiSelect: true } : {}),
          ...(marked !== undefined ? { recommended: marked.replace(RECOMMENDED, "") } : {}),
        };
      });
      if (!questions.length) return false;
      state.questions.set(id, questions);
      return true;
    },

    // The ask_question calls still open, in the order agy asked them.
    openQuestionCalls() {
      return [...state.activeToolCalls].filter((id) => state.isQuestion(id));
    },

    openQuestions() {
      return state.openQuestionCalls().flatMap((id) => state.questions.get(id) ?? []);
    },

    // True while a message chunk still belongs in the result: before any tool ran, or after
    // the last one finished.
    collectingResult() {
      return !state.sawToolCall || (state.collectingPostToolResult && state.activeToolCalls.size === 0);
    },

    // Merges a frame into its call's record. A fresh tool_call for a finished id is a new call (agy
    // reusing the id); the finished record keeps its place under a key of its own.
    recordToolCall(up, isArtifact) {
      const id = up?.toolCallId;
      if (id == null) return;
      let rec = state.toolCallRecords.get(id);
      if (rec && up.sessionUpdate === "tool_call" && isTerminalToolStatus(rec.status) && !isTerminalToolStatus(up.status)) {
        state.toolCallRecords = new Map([...state.toolCallRecords].map(([k, v]) => [k === id ? Symbol() : k, v]));
        rec = undefined;
      }
      rec ??= {};
      if (isArtifact) rec.artifact = true;
      if (typeof up.kind === "string" && up.kind) rec.kind = up.kind;
      if (typeof up.title === "string" && up.title) rec.title = up.title;
      if (typeof up.rawInput?.CommandLine === "string") rec.command = up.rawInput.CommandLine;
      if (Number.isInteger(up.rawOutput?.exit_code)) rec.exitCode = up.rawOutput.exit_code;
      if (typeof up.status === "string"
        && (up.sessionUpdate === "tool_call" || isTerminalToolStatus(up.status) || !isTerminalToolStatus(rec.status))) {
        rec.status = up.status;
      }
      state.toolCallRecords.set(id, rec);
    },

    // The artifact's content arrives whole in rawInput.Content; Path is where agy saved it.
    recordArtifact(input) {
      const meta = input?.ArtifactMetadata;
      if (!meta || typeof meta !== "object" || typeof input.Path !== "string" || !input.Path) return false;
      state.artifacts.set(input.Path, {
        path: input.Path,
        ...(typeof meta.Summary === "string" ? { summary: meta.Summary } : {}),
        ...(typeof input.Content === "string" ? { content: input.Content } : {}),
      });
      return true;
    },
  };
  return state;
}
