// src/research/harness.mjs — the Claude Agent SDK harness.
//
// This is what "wrapping LangGraph in an agent harness" means concretely: the
// graph decides WHEN and IN WHAT ORDER work happens; this file decides HOW a
// single unit of work gets done. A DagNodeSpec is a row of data whose
// `instruction` is a natural-language string — executeNode turns that string
// into one agent turn with tools, streaming, and a human-in-the-loop gate.
//
// The HITL seam is `canUseTool`. That is deliberate: the SDK already pauses the
// model mid-turn waiting for that promise to settle, so a human can approve,
// edit, or reject a specific tool call WITHOUT us re-implementing pause/resume
// at the message layer.
import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { makeResearchMcpServer, RESEARCH_TOOL_NAMES, bindSink } from "./tools.mjs";

const BUILTIN_TOOLS = ["WebSearch", "WebFetch"];

/** Compact the facilities-so-far so the prompt stays small on wide runs. */
function compactFacilities(facilities) {
  const list = Array.isArray(facilities) ? facilities : [];
  return list.slice(0, 40).map((f) => ({
    id: f.id,
    name: f.name,
    distanceMiles: f.distanceMiles?.value ?? null,
    beds: f.beds?.value ?? null,
    avgMonthlyFee: f.avgMonthlyFee?.value ?? null,
    management: f.management?.value ?? null,
    acos: f.acos?.value ?? null,
    services: f.services?.value ?? null,
  }));
}

function buildPrompt(node, state) {
  const known = compactFacilities(state.facilities);
  return [
    `You are executing one node of an assisted-living-facility research pipeline.`,
    ``,
    `NODE: ${node.id} — ${node.label || node.id}`,
    `INSTRUCTION: ${node.instruction}`,
    ``,
    `TARGET ZIP: ${state.zip}`,
    `FACILITIES COLLECTED SO FAR (${known.length}):`,
    "```json",
    JSON.stringify(known, null, 0),
    "```",
    ``,
    `RULES:`,
    `- Use mcp__research__zip_centroid to anchor the zip, mcp__research__haversine_miles for distances.`,
    `- Write ALL results with mcp__research__record_facilities. Nothing you say in prose is captured.`,
    `- Every field must be {value, prov:{source, confidence, note}}. If you do not know a value,`,
    `  send {value:null, prov:{source:"unknown", confidence:0, note:"..."}}. NEVER invent a number.`,
    `- Reuse the exact existing \`id\` when enriching a facility you can already see above.`,
    `- Finish with one short line summarizing what you added or changed.`,
  ].join("\n");
}

/**
 * Run ONE DagNodeSpec as an agent turn.
 * @param {{node:any, state:any, runId:string, emit:Function, hitl?:any}} args
 * @returns {Promise<{facilities:any[], summary:string, usage:any}>}
 */
export async function executeNode({ node, state, runId, emit = () => {}, hitl }) {
  const collected = new Map();
  const releaseSink = bindSink((batch) => {
    for (const f of batch) collected.set(f.id, { ...(collected.get(f.id) || {}), ...f });
  });

  const usage = { input_tokens: 0, output_tokens: 0 };
  let summary = "";
  let toolCalls = 0;

  // --- the HITL seam -------------------------------------------------------
  // The SDK awaits this callback before the tool executes. We emit a `hitl`
  // RunEvent carrying a HitlRequest and then block on a promise the API route
  // (POST /api/research/hitl) resolves. Return shape is PermissionResult:
  //   {behavior:"allow", updatedInput} | {behavior:"deny", message}
  const canUseTool = async (toolName, input, opts) => {
    // Scope fence. permissionMode "default" + an allow-everything callback lets
    // the model reach for Bash and spawn sub-Agents, which turns one research
    // node into an unbounded fan-out that never gets around to recording
    // anything. Anything outside the node's tool budget is denied with an
    // instruction, not silently allowed.
    if (!IN_SCOPE.has(toolName)) {
      emit({ type: "tool_denied", runId, nodeId: node.id, tool: toolName, ts: new Date().toISOString() });
      return {
        behavior: "deny",
        message:
          `Tool "${toolName}" is out of scope for this node. Use only: ` +
          `${RESEARCH_TOOL_NAMES.join(", ")}, WebSearch, WebFetch. ` +
          `Wrap up now and call mcp__research__record_facilities with what you have ` +
          `(use {value:null, prov:{source:"unknown", confidence:0}} for anything you could not verify).`,
      };
    }

    let gate = false;
    try { gate = Boolean(hitl?.shouldGate?.(node.id, toolName, input)); } catch { gate = false; }
    if (!gate) return { behavior: "allow", updatedInput: input };

    const requestId = randomUUID();
    /** @type {import("./contract.mjs")} HitlRequest */
    const request = {
      id: requestId,
      runId,
      nodeId: node.id,
      kind: "approve_tool",
      question: opts?.title || `Allow ${toolName} in node "${node.label || node.id}"?`,
      payload: { toolName, input, displayName: opts?.displayName },
    };

    let answer;
    try {
      const pending = hitl.wait(requestId, request); // route resolves this
      emit({ type: "hitl", runId, nodeId: node.id, request, ts: new Date().toISOString() });
      answer = await pending;
    } catch (e) {
      // If the wait plumbing is unavailable, fail OPEN on read-only research
      // tools rather than deadlocking the run forever.
      emit({ type: "error", runId, nodeId: node.id, message: `hitl wait failed: ${e.message}` });
      return { behavior: "allow", updatedInput: input };
    }

    emit({ type: "hitl_resolved", runId, nodeId: node.id, requestId, decision: answer?.decision });
    if (answer?.decision === "reject") {
      return { behavior: "deny", message: answer.feedback || "Rejected by human reviewer." };
    }
    if (answer?.decision === "edit" && answer.edited && typeof answer.edited === "object") {
      return { behavior: "allow", updatedInput: answer.edited };
    }
    return { behavior: "allow", updatedInput: input };
  };

  // A bare name in `allowedTools` auto-approves that tool BEFORE canUseTool is
  // consulted (the SDK warns about exactly this). So any tool we intend to gate
  // must be left OUT of allowedTools and allowed by the callback instead —
  // otherwise the HITL seam is silently dead. Ungated tools stay listed so the
  // common path never round-trips through the callback.
  const allTools = [...RESEARCH_TOOL_NAMES, ...BUILTIN_TOOLS];
  // ToolSearch is how the SDK surfaces deferred tool schemas — without it the
  // model cannot call our MCP tools at all, so it is in scope but not "work".
  const IN_SCOPE = new Set([...allTools, "ToolSearch"]);
  const allowedTools = allTools.filter((name) => {
    try { return !hitl?.shouldGate?.(node.id, name, {}); } catch { return true; }
  });

  try {
    const stream = query({
      prompt: buildPrompt(node, state),
      options: {
        // Fresh per node turn — the enrichment nodes run concurrently and a
        // shared instance starves all but one of them. See makeResearchMcpServer.
        mcpServers: { research: makeResearchMcpServer() },
        allowedTools,
        maxTurns: 8,
        permissionMode: "default",
        canUseTool,
      },
    });

    for await (const msg of stream) {
      if (!msg || typeof msg !== "object") continue;

      if (msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block?.type === "tool_use") {
            toolCalls += 1;
            emit({
              type: "tool", runId, nodeId: node.id,
              tool: block.name, input: block.input,
              ts: new Date().toISOString(),
            });
          } else if (block?.type === "text" && block.text?.trim()) {
            summary = block.text.trim().split("\n").filter(Boolean).pop() || summary;
          }
        }
        const u = msg.message?.usage;
        if (u) {
          usage.input_tokens += u.input_tokens || 0;
          usage.output_tokens += u.output_tokens || 0;
        }
      } else if (msg.type === "result") {
        if (typeof msg.result === "string" && msg.result.trim()) {
          summary = msg.result.trim().split("\n").filter(Boolean).pop() || summary;
        }
        if (msg.usage) {
          usage.input_tokens += msg.usage.input_tokens || 0;
          usage.output_tokens += msg.usage.output_tokens || 0;
        }
        if (typeof msg.total_cost_usd === "number") usage.cost_usd = msg.total_cost_usd;
      }
    }
  } catch (e) {
    // A dead node must not kill the graph. Emit, keep the state, carry on.
    emit({
      type: "error", runId, nodeId: node.id,
      message: `node ${node.id} failed: ${e?.message || String(e)}`,
      ts: new Date().toISOString(),
    });
    releaseSink();
    return { facilities: [], summary: `error: ${e?.message || "unknown"}`, usage, error: true };
  } finally {
    releaseSink();
  }

  const facilities = [...collected.values()];
  summary = (summary || `${facilities.length} facility record(s), ${toolCalls} tool call(s)`).slice(0, 240);
  emit({
    type: "node_end", runId, nodeId: node.id, label: node.label || node.id,
    summary, count: facilities.length, usage, ts: new Date().toISOString(),
  });
  return { facilities, summary, usage };
}

export default { executeNode };
