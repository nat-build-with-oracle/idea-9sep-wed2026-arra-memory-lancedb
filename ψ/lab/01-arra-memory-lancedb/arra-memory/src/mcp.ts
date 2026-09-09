import {
  createMemory,
  type CreateMemoryInput,
  deleteMemory,
  getMemory,
  getMemoryStats,
  listAgents,
  listMonths,
  listProjects,
  listTags,
  listWorkspaces,
  searchInRange,
  recallMemories,
  searchMemories,
  updateMemory,
  type Memory,
} from "./memory";
import { setting } from "./config";
import { listFleet, sendToMember, memberReplies, fleetStatus } from "./fleet";
import { VERSION } from "./version";
import { INSTANCE_NAME } from "./identity";
import { buildDigest, digestWindows } from "./digest";
import {
  clearSearchLog,
  deleteSearchLogEntry,
  listSearchLog,
  pruneSearchLog,
  searchLogStats,
} from "./searchlog";
import { disabledTools, setToolDisabled, UNDISABLEABLE } from "./tools";
import { RELATIVE_RANGES, resolveRange } from "./timerange";
import { SUGGESTED_KINDS, slugify, type MemoryKind } from "./utils";

/**
 * The MCP surface.
 *
 * Implemented directly against the JSON-RPC wire format rather than through the
 * SDK's transport layer: this add-on serves one stateless POST endpoint, and
 * hand-rolling that is a few dozen lines against an SDK transport built for
 * session management we do not want.
 *
 * The interesting part is that `tools/list` is not a constant. Base tools are
 * fixed, but the corpus also GENERATES tools: every project with memories in it
 * becomes its own `recall_<project>` tool. A model then sees the shape of the
 * archive in the tool list itself, instead of having to know that `project` is
 * a parameter and guess which values are real. `listChanged` is advertised so a
 * client knows the list is live, and re-reads it after writes.
 */

/**
 * Protocol versions this server will speak, newest first.
 *
 * The negotiation rule matters more than the list. A server MUST answer
 * `initialize` with a version the CLIENT can speak — echoing the client's
 * requested version when it is supported, and only falling back to its own
 * preference when it is not. Replying with a version the client does not know
 * is a silent, total failure: the client completes the handshake, reports
 * itself connected, and then never calls tools/list.
 *
 * Measured against claude.ai on 2026-08-28: it requested `2025-06-18`, this
 * server answered `2026-07-28` because the value was hard-coded, and the
 * connector showed "connected" with "no tools available" and no error anywhere.
 *
 * The wire format has not changed across these revisions for what this server
 * implements — initialize, tools/list, tools/call over JSON-RPC — so accepting
 * all of them is honest rather than merely permissive.
 */
const SUPPORTED_PROTOCOL_VERSIONS = [
  "2026-07-28",
  "2025-11-25", // what claude.ai actually speaks — measured, not guessed
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

const PREFERRED_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/**
 * Echo the client's version when we can speak it; otherwise offer our own.
 *
 * The list above is explicit, but any well-formed YYYY-MM-DD revision is also
 * accepted. That is not laxness — this server implements three methods over
 * plain JSON-RPC (initialize, tools/list, tools/call) and none of them has
 * changed shape across any published revision. Refusing a version we would in
 * fact serve correctly costs the entire connection and says nothing useful.
 *
 * The list is still worth keeping: it documents what has actually been tested,
 * and it is what a reader checks first when a new client will not connect.
 */
function negotiateProtocol(requested: unknown): string {
  if (typeof requested !== "string") return PREFERRED_PROTOCOL_VERSION;
  if ((SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) return requested;
  return /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : PREFERRED_PROTOCOL_VERSION;
}

/** How many projects may become their own tool. Beyond this, use the filter. */
const MAX_GENERATED_TOOLS = 12;

/** Prefix that marks a tool as corpus-generated rather than hand-written. */
const PROJECT_TOOL_PREFIX = "recall_project_";

/** Prefix for the time-window tools: search_today, search_2026_08, … */
const TIME_TOOL_PREFIX = "search_";

/** How many calendar months become their own tool. Older months stay reachable
 *  through `search_memories_between`, which takes explicit dates. */
const MAX_MONTH_TOOLS = 6;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const ok = (id: JsonRpcRequest["id"], result: unknown) => ({
  jsonrpc: "2.0" as const,
  id: id ?? null,
  result,
});

const fail = (id: JsonRpcRequest["id"], code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  id: id ?? null,
  error: { code, message },
});

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

const toolError = (message: string) => ({
  isError: true,
  content: [{ type: "text" as const, text: message }],
});

/** One memory rendered for a model to read: header, body, then provenance. */
function render(memory: Memory): string {
  const tags = memory.tags.length ? ` #${memory.tags.join(" #")}` : "";
  const provenance = [
    `id: ${memory.id}`,
    `importance: ${memory.importance}/5`,
    memory.workspace && `workspace: ${memory.workspace}`,
    memory.project && `project: ${memory.project}`,
    memory.url && `url: ${memory.url}`,
    `source: ${memory.source}`,
    memory.createdBy && `by: ${memory.createdBy}`,
    `updated: ${memory.updatedAt}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return [`[${memory.kind}] ${memory.title}${tags}`, memory.content, provenance].join("\n");
}

// ── static tools ──────────────────────────────────────────────────────────────

/**
 * Kind, described rather than enumerated.
 *
 * No `enum`: the vocabulary is open, so constraining the schema would refuse a
 * word the owner has legitimately started using. The suggestions go in the
 * description instead, which is where a model actually reads them — and an
 * `examples` array so a client that renders hints has something to show.
 */
const KIND_ENUM = {
  type: "string",
  description:
    `What this memory IS. Free text — reuse an existing kind where one fits, and ` +
    `call list_kinds to see what the corpus already uses. Common: ` +
    `${SUGGESTED_KINDS.join(", ")}.`,
  examples: [...SUGGESTED_KINDS],
};

const WORKSPACE_PROP = {
  type: "string",
  description:
    "Workspace this belongs to — the team-level namespace one tier above project. One workspace holds many projects, e.g. workspace \"arra-memory-haos\" with projects \"oauth\" and \"fts\". Free-form: a workspace exists as soon as a memory names it.",
};

const PROVENANCE_PROPS = {
  workspace: WORKSPACE_PROP,
  project: {
    type: "string",
    description: "Project this belongs to, e.g. github.com/owner/repo.",
  },
  url: { type: "string", description: "Reference URL. Must be http or https." },
  createdBy: { type: "string", description: "Who or what produced this memory." },
};

/**
 * The scope filters every search tool accepts.
 *
 * All optional, and omitting one means "do not narrow on it" — so a client that
 * has never heard of workspaces still searches the entire corpus and a client
 * that has can scope down without a different tool. This is what makes workspace
 * and agent filters rather than boundaries.
 */
const SCOPE_PROPS = {
  workspace: {
    type: "string",
    description:
      "Only memories in this workspace. Omit to search every workspace. Call list_workspaces to see what exists.",
  },
  project: {
    type: "string",
    description: "Only memories filed under this project.",
  },
  createdBy: {
    type: "string",
    description:
      "Only memories written by this agent or person. Call list_agents to see who has written to the corpus.",
  },
};

/** The one property the workspace-aware list tools share. */
const WORKSPACE_FILTER_PROP = {
  workspace: {
    type: "string",
    description: "Only count what is inside this workspace. Omit for the whole corpus.",
  },
};

const BASE_TOOLS = [
  {
    name: "remember",
    description:
      "Persist a durable memory. Use for facts, decisions, lessons, people, projects, or context worth recalling later.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", minLength: 1, maxLength: 12000 },
        title: { type: "string", minLength: 1, maxLength: 160 },
        kind: KIND_ENUM,
        tags: { type: "array", items: { type: "string" }, maxItems: 10 },
        importance: { type: "integer", minimum: 1, maximum: 5 },
        ...PROVENANCE_PROPS,
      },
      required: ["content"],
    },
  },
  {
    name: "recall_memories",
    description:
      "Recall memories across titles, content, and tags — by meaning and by keyword together, so a question phrased differently from the memory still finds it. Optionally narrowed by kind, workspace, project, agent, or tag. An empty query returns the most recent important memories. The response reports `matchMode`, which is what ACTUALLY ran: if it says `keyword`, embeddings were unavailable and a differently-worded question may still have an answer.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 240 },
        mode: {
          type: "string",
          enum: ["hybrid", "semantic", "keyword"],
          description:
            "How to search. `hybrid` (default) fuses meaning and keyword, and falls back to keyword — saying so — if embeddings are unavailable. `semantic` is meaning only and FAILS rather than degrade. `keyword` is a literal scan: correct for exact strings such as an id, a filename, or an error message, where meaning-based recall is the wrong tool.",
        },
        kind: KIND_ENUM,
        ...SCOPE_PROPS,
        tag: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: "read_memory",
    description: "Read one exact memory by its stable id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "revise_memory",
    description: "Revise fields on an existing memory, preserving its id and creation time.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string", minLength: 1, maxLength: 160 },
        content: { type: "string", minLength: 1, maxLength: 12000 },
        kind: KIND_ENUM,
        tags: { type: "array", items: { type: "string" }, maxItems: 10 },
        importance: { type: "integer", minimum: 1, maximum: 5 },
        ...PROVENANCE_PROPS,
      },
      required: ["id"],
    },
  },
  {
    name: "forget_memory",
    description:
      "Permanently delete one memory by id. Use only when the owner clearly asks to forget it.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  {
    name: "memory_stats",
    description: "Summarize the corpus: total, counts by kind, top tags, last update.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_workspaces",
    description:
      "List every workspace in the corpus with how many memories, projects, and agents it holds. A workspace is the tier above project — start here to find out how the archive is divided before searching it.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
    },
  },
  {
    name: "list_agents",
    description:
      "List who has written to the corpus — every distinct createdBy value with its memory count. Use the names it returns as the createdBy filter on any search tool.",
    inputSchema: {
      type: "object",
      properties: {
        ...WORKSPACE_FILTER_PROP,
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "list_projects",
    description:
      "List every project in the corpus with its memory count, optionally only those inside one workspace. Each of these also appears as its own recall tool.",
    inputSchema: {
      type: "object",
      properties: {
        ...WORKSPACE_FILTER_PROP,
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "list_tags",
    description:
      "List every tag in the corpus with how often it is used, optionally only the tags actually used inside one workspace.",
    inputSchema: {
      type: "object",
      properties: {
        ...WORKSPACE_FILTER_PROP,
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "list_search_log",
    description:
      "List recent searches with the query text, what was returned, and when. Only populated when the search log is enabled in the add-on configuration.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200 },
        query: { type: "string", description: "Only entries whose query contains this." },
      },
    },
  },
  {
    name: "forget_search_log",
    description:
      "Delete search log entries: one by id, everything older than N days, or all of it. Exactly one of id/olderThanDays/all must be given.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Delete exactly this entry." },
        olderThanDays: {
          type: "integer",
          minimum: 0,
          description: "Delete entries older than this many days, e.g. 30.",
        },
        all: { type: "boolean", description: "Delete every entry. Irreversible." },
      },
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  },
  {
    name: "list_tools",
    description:
      "List every tool this connector can offer, whether it is currently enabled, and whether it was generated from the corpus rather than defined in source.",
    inputSchema: {
      type: "object",
      properties: {
        includeDisabled: {
          type: "boolean",
          description: "Include tools that are switched off. Defaults to true.",
        },
      },
    },
  },
  {
    name: "toggle_tool",
    description:
      "Switch one tool on or off. A disabled tool is hidden from tools/list and refused if called. Nothing is deleted — re-enabling brings it straight back.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The tool to change." },
        enabled: {
          type: "boolean",
          description: "true to switch on, false to switch off. Omit to flip it.",
        },
      },
      required: ["name"],
    },
  },
  {
    /**
     * The one tool that returns a DOCUMENT rather than a result set.
     *
     * "What did we work out this week" is not a search — it is a request for
     * material to reason over, and a JSON array of memory objects is the wrong
     * shape for that: most of its tokens go to ids and repeated field names, and
     * it arrives with no structure. This returns markdown grouped by kind, which
     * is the summary's outline before a model writes a word.
     */
    name: "digest",
    description:
      "Assemble every memory from a time window into one markdown document, grouped by kind — built for summarising rather than searching. Use this for “what happened today / this week”, and recall_memories when looking for something specific.",
    inputSchema: {
      type: "object",
      properties: {
        window: {
          type: "string",
          description:
            "today, yesterday, last_7days, last_2weeks, last_3weeks, last_1month, last_3months, last_6months, last_1year, or a month like 2026_08. Relative windows all run up to now.",
        },
        query: { type: "string", maxLength: 240 },
        kind: KIND_ENUM,
        ...SCOPE_PROPS,
        excerpt: {
          type: "integer",
          minimum: 100,
          description: "Trim each memory to this many characters. Omit for full text.",
        },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["window"],
    },
  },
  {
    // The escape hatch behind the generated time tools: any window at all,
    // including ones older than the months offered as their own tools.
    name: "search_memories_between",
    description:
      "Search memories created between two dates (ISO-8601, e.g. 2026-01-01). Use the named search_* tools for common windows; use this for anything else.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start date, inclusive. ISO-8601." },
        to: { type: "string", description: "End date, inclusive. ISO-8601." },
        query: { type: "string", maxLength: 240 },
        kind: KIND_ENUM,
        ...SCOPE_PROPS,
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["from", "to"],
    },
  },
  // ── the fleet, not the corpus ────────────────────────────────────────────
  //
  // These reach the oracle-registry running beside us. They are deliberately
  // NOT named list_agents / send_message: `list_agents` already exists here and
  // answers a DIFFERENT question — who has ever written a memory — while this
  // answers who is alive right now. A model handed two tools whose names imply
  // the same thing will pick the wrong one, and the wrong one will look like it
  // worked. Historical authorship and live presence are different facts and get
  // different names.
  {
    name: "list_fleet",
    description:
      "List the oracle fleet as the message broker currently describes it — every member, whether it is online, whether a chat channel is attached (only those can be messaged), its host and version, and when it was last seen. Read live from retained MQTT state. This is NOT list_agents, which lists who has written memories to this corpus.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "send_to_oracle",
    description:
      "Send a message to another oracle's chat channel. Returns the message id and the exact topic it was published to. Fire-and-forget: success means the registry accepted and published it, NOT that the other oracle read it. Poll oracle_replies for an answer.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Target oracle, as shown by list_oracles." },
        text: { type: "string", description: "The message." },
        room: { type: "string", description: "Room within that oracle's channel. Defaults to main." },
      },
      required: ["name", "text"],
    },
  },
  {
    name: "oracle_replies",
    description:
      "Recent replies from an oracle's channel. Reads an in-memory ring on the registry, so it polls RECENT traffic and is not a durable inbox — an empty result means nothing is buffered, never that no reply was sent.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Oracle whose replies to read." },
        since: { type: "number", description: "Only replies with a sequence number above this." },
      },
      required: ["name"],
    },
  },
];

// ── generated tools ───────────────────────────────────────────────────────────

/**
 * Builds the live tool list: the static tools above, plus one recall tool per
 * project actually present in the corpus.
 *
 * Slug collisions are resolved by keeping the busiest project — two projects
 * that slugify identically would otherwise produce two tools with one name,
 * and a client is entitled to treat that as malformed.
 */
async function buildToolList() {
  // Generated tools are OFF by default since 0.25.0, and the reason is a
  // measurement rather than a preference. On a real corpus they were 18 of 34
  // tools and 4,328 of 7,133 tokens — 61% of what every MCP client carries in
  // context on every single request.
  //
  // They are also strictly redundant. `recall_project_X` is
  // `recall_memories({project: "X"})`; `search_last_7days` is
  // `search_memories_between({from, to})`. Nothing becomes impossible when
  // they are off.
  //
  // What is genuinely lost is DISCOVERY — a model could read the archive's
  // shape out of the tool list instead of guessing project names. That job is
  // done by `list_projects` and `list_workspaces`, which are always on, cost a
  // few dozen tokens between them, and answer it on demand rather than in
  // every request forever.
  //
  // Turn them back on with the `generated_tools` option when the trade is
  // worth it — a small corpus, or a client where the affordance matters more
  // than the context.
  if (setting("generated_tools").toLowerCase() !== "true") {
    const off = await disabledTools();
    return {
      tools: BASE_TOOLS.filter((t: any) => !off.has(t.name)),
      generated: [] as Array<Record<string, unknown>>,
      // The catalog must still list every base tool with its state, or the
      // settings page would render an empty list and look broken.
      catalog: BASE_TOOLS.map((t: any) => ({
        name: t.name,
        description: t.description,
        generated: false,
        project: null,
        destructive: Boolean(t.annotations?.destructiveHint),
        disabled: off.has(t.name),
      })),
    };
  }

  const [projects, months] = await Promise.all([
    listProjects(MAX_GENERATED_TOOLS * 2),
    listMonths(MAX_MONTH_TOOLS),
  ]);

  const taken = new Set<string>();
  const generated: Array<Record<string, unknown>> = [];

  // One recall tool per project actually in the corpus.
  for (const facet of projects) {
    if (generated.length >= MAX_GENERATED_TOOLS) break;
    const slug = slugify(facet.project);
    if (!slug || taken.has(slug)) continue;
    taken.add(slug);

    generated.push({
      name: `${PROJECT_TOOL_PREFIX}${slug}`,
      description: `Recall memories filed under “${facet.project}” (${facet.count} stored). Optionally narrow with a keyword query.`,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", maxLength: 240 },
          kind: KIND_ENUM,
          // A project name is not globally unique — two workspaces may both
          // have an "oauth" project — so the tool still accepts a workspace to
          // disambiguate. `createdBy` is here for the same reason it is on every
          // other search tool: "what did the other agent decide about this".
          workspace: SCOPE_PROPS.workspace,
          createdBy: SCOPE_PROPS.createdBy,
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
      },
      // The literal project string travels with the tool so dispatch does not
      // have to reverse the slug — slugify is lossy and not invertible.
      _project: facet.project,
    });
  }

  const timeSchema = {
    type: "object",
    properties: {
      query: { type: "string", maxLength: 240 },
      kind: KIND_ENUM,
      // "What did this workspace do last week" and "what did that agent write
      // yesterday" are the two questions a shared corpus makes urgent, and both
      // are a time window plus one filter.
      ...SCOPE_PROPS,
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
  };

  // The relative windows are always offered: "what did we decide last week" is
  // a question worth answering even against an empty corpus.
  for (const [key, range] of Object.entries(RELATIVE_RANGES)) {
    generated.push({
      name: `${TIME_TOOL_PREFIX}${key}`,
      description: `Search memories created in ${range.label}. Optionally narrow with a keyword query.`,
      inputSchema: timeSchema,
    });
  }

  // Calendar months are offered only where the corpus has something, so a
  // model is never handed a tool that can only return nothing.
  for (const { month, count } of months) {
    const token = month.replace("-", "_"); // 2026-08 → 2026_08
    generated.push({
      name: `${TIME_TOOL_PREFIX}${token}`,
      description: `Search the ${count} memories created in ${month}.`,
      inputSchema: timeSchema,
    });
  }

  // A span across the two most recent months, which is the range people ask
  // for most often after "this month" and cannot express with one month tool.
  if (months.length >= 2) {
    const [newest, older] = months;
    generated.push({
      name: `${TIME_TOOL_PREFIX}${older.month.replace("-", "_")}_to_${newest.month.replace("-", "_")}`,
      description: `Search memories created from ${older.month} through ${newest.month}.`,
      inputSchema: timeSchema,
    });
  }

  const all = [...BASE_TOOLS, ...generated];
  const off = await disabledTools();

  return {
    // What a client sees: everything the owner has not switched off.
    tools: all.filter((t: any) => !off.has(t.name)),
    generated,
    // What the UI sees: every tool that COULD exist, with its state, so a
    // disabled tool is still listed and can be switched back on.
    catalog: all.map((t: any) => ({
      name: t.name,
      description: t.description,
      generated: Boolean(t._project) || (t.name.startsWith(TIME_TOOL_PREFIX) && t.name !== "search_memories_between"),
      project: t._project ?? null,
      destructive: Boolean(t.annotations?.destructiveHint),
      disabled: off.has(t.name),
    })),
  };
}

/** The annotated catalog, for the UI and for /api/tools. */
export async function toolCatalog() {
  return (await buildToolList()).catalog;
}

// ── tool dispatch ─────────────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, any>) {
  // A generated tool is the same recall with its project pre-bound. Resolve it
  // against the live list rather than un-slugging, so a tool that no longer
  // exists reports that instead of silently searching the wrong project.
  if (name.startsWith(PROJECT_TOOL_PREFIX)) {
    const { generated } = await buildToolList();
    const tool = generated.find((t) => t.name === name);
    if (!tool) {
      return toolError(
        `No project tool named ${name}. The corpus may have changed — call list_projects or re-read tools/list.`,
      );
    }
    return recall({ ...args, project: tool._project as string });
  }

  // A time tool is a range query with its window pre-bound. The suffix is
  // parsed rather than looked up, so `search_2026_03` works even though March
  // is too old to have been offered as a generated tool.
  if (name.startsWith(TIME_TOOL_PREFIX)) {
    const range = resolveRange(name.slice(TIME_TOOL_PREFIX.length));
    if (range) {
      const memories = await searchInRange({
        fromIso: range.fromIso,
        toIso: range.toIso,
        query: args.query,
        ...scopeFrom(args),
        limit: args.limit ?? 20,
        label: range.label,
        source: "mcp",
      });

      const narrowed = describeScope(args);
      const body = memories.length
        ? memories.map((m, i) => `${i + 1}. ${render(m)}`).join("\n\n")
        : `No memories from ${range.label}${args.query ? ` matching “${args.query}”` : ""}${narrowed ? ` in ${narrowed}` : ""}.`;
      return {
        ...text(body),
        structuredContent: {
          window: range.label,
          from: range.fromIso,
          to: range.toIso,
          matchMode: "keyword",
          ...scopeFrom(args),
          count: memories.length,
          memories,
        },
      };
    }
    // Falls through: `search_memories_between` also starts with this prefix.
  }

  switch (name) {
    case "remember": {
      const memory = await createMemory({
        ...(args as CreateMemoryInput),
        source: args.source ?? "claude",
        createdBy: args.createdBy ?? "claude",
      });
      return { ...text(`Remembered.\n\n${render(memory)}`), structuredContent: { memory } };
    }

    case "recall_memories":
      return recall(args);

    case "read_memory": {
      const memory = await getMemory(args.id);
      if (!memory) return toolError(`Memory ${args.id} was not found.`);
      return { ...text(render(memory)), structuredContent: { memory } };
    }

    case "revise_memory": {
      const { id, ...updates } = args;
      if (Object.keys(updates).length === 0) {
        return toolError("Provide at least one field to revise.");
      }
      const memory = await updateMemory(id, updates);
      if (!memory) return toolError(`Memory ${id} was not found.`);
      return { ...text(`Revised.\n\n${render(memory)}`), structuredContent: { memory } };
    }

    case "forget_memory": {
      const deleted = await deleteMemory(args.id);
      if (!deleted) return toolError(`Memory ${args.id} was not found.`);
      return {
        ...text(`Forgot memory ${args.id}.`),
        structuredContent: { id: args.id, deleted: true },
      };
    }

    case "memory_stats": {
      const stats = await getMemoryStats();
      return { ...text(JSON.stringify(stats, null, 2)), structuredContent: { stats } };
    }

    case "list_workspaces": {
      const { workspaces, unassigned } = await listWorkspaces(args.limit ?? 50);
      const lines = workspaces.map(
        (w) =>
          `${w.workspace} — ${w.count} memories, ${w.projects} project(s), ${w.agents} agent(s), last ${w.latest}`,
      );
      // The unassigned count is stated even when it is the only thing to say.
      // A workspace list that quietly omits part of the corpus would have a
      // model conclude the archive is empty when it is merely unfiled.
      if (unassigned) {
        lines.push(`(no workspace) — ${unassigned} memories not filed under any workspace`);
      }
      const body = lines.length ? lines.join("\n") : "No memories yet.";
      return { ...text(body), structuredContent: { workspaces, unassigned } };
    }

    case "list_agents": {
      const agents = await listAgents(args.limit ?? 50, args.workspace);
      const where = args.workspace ? ` in workspace “${args.workspace}”` : "";
      const body = agents.length
        ? agents.map((a) => `${a.agent} — ${a.count} memories, last ${a.latest}`).join("\n")
        : `No memories record who wrote them${where}.`;
      return { ...text(body), structuredContent: { agents, workspace: args.workspace ?? "" } };
    }

    case "list_fleet": {
      const r = listFleet();
      if (!r.ok) return text(`Cannot see the fleet: ${r.error}`);
      const body = r.members.length
        ? r.members
            .map(
              (m) =>
                `${m.state === "online" ? "\u25cf" : "\u25cb"} ${m.name}` +
                `${m.channel ? " \u00b7 chat" : " \u00b7 no channel"}` +
                `${m.host ? ` \u00b7 ${m.host}` : ""}` +
                `${m.version ? ` \u00b7 v${m.version}` : ""}` +
                `${m.seen ? ` \u00b7 seen ${m.seen}` : ""}`,
            )
            .join("\n")
        : "No member has published presence to the broker. Connected, but the fleet is silent.";
      return { ...text(body), structuredContent: { members: r.members, connection: fleetStatus() } };
    }

    case "send_to_oracle": {
      const r = await sendToMember(
        String(args.name),
        String(args.text),
        args.room ? String(args.room) : undefined,
      );
      // The registry's own status is passed through rather than flattened:
      // 403 (this key cannot dispatch), 404 (no such member), 429 (rate
      // limited) and 503 (no dispatch login configured) each call for a
      // different next move, and one generic "failed" hides which happened.
      if (!r.ok) return text(`Not sent: ${r.error}`);
      return {
        ...text(
          `Sent to ${args.name} (id ${r.id}, topic ${r.topic}). Published, not read \u2014 poll oracle_replies for an answer.`,
        ),
        structuredContent: { sent: true, id: r.id, topic: r.topic },
      };
    }

    case "oracle_replies": {
      const list = memberReplies(args.name ? String(args.name) : undefined, Number(args.since ?? 0));
      const body = list.length
        ? list.map((r) => `[${r.seq}] ${r.name}/${r.room} ${r.at}\n${r.text}`).join("\n\n")
        : `Nothing buffered${args.name ? ` from ${args.name}` : ""}. This is a short in-memory ring of live traffic, so an empty result does not prove no reply was sent.`;
      return { ...text(body), structuredContent: { replies: list } };
    }

    case "list_projects": {
      const projects = await listProjects(args.limit ?? 20, args.workspace);
      const where = args.workspace ? ` in workspace “${args.workspace}”` : "";
      const body = projects.length
        ? projects
            .map((p) => `${p.project} — ${p.count} memories, last ${p.latest}`)
            .join("\n")
        : `No memories carry a project${where} yet.`;
      return {
        ...text(body),
        structuredContent: { projects, workspace: args.workspace ?? "" },
      };
    }

    case "list_tags": {
      const tags = await listTags(args.limit ?? 50, args.workspace);
      const where = args.workspace ? ` in workspace “${args.workspace}”` : "";
      const body = tags.length
        ? tags.map((t) => `${t.tag} (${t.count})`).join(", ")
        : `No tags${where} yet.`;
      return { ...text(body), structuredContent: { tags, workspace: args.workspace ?? "" } };
    }

    case "list_search_log": {
      const entries = await listSearchLog(args.limit ?? 50, args.query);
      const stats = await searchLogStats();
      if (!stats.enabled) {
        return {
          ...text(
            "The search log is switched off. Enable `search_log` in this add-on's configuration to start recording queries.",
          ),
          structuredContent: { enabled: false, entries: [] },
        };
      }
      const body = entries.length
        ? entries
            .map(
              (e) =>
                `${e.createdAt}  “${e.query || "(empty)"}”  → ${e.resultCount} result(s), ${e.durationMs}ms${e.mode !== "keyword" ? `, ${e.mode}` : ""}`,
            )
            .join("\n")
        : "No searches recorded yet.";
      return { ...text(body), structuredContent: { enabled: true, stats, entries } };
    }

    case "forget_search_log": {
      // Exactly one mode, so an ambiguous call cannot delete more than intended.
      const modes = [args.id, args.olderThanDays, args.all].filter(
        (v) => v !== undefined && v !== null && v !== false,
      );
      if (modes.length !== 1) {
        return toolError("Give exactly one of: id, olderThanDays, or all.");
      }
      if (args.id) {
        const ok2 = await deleteSearchLogEntry(String(args.id));
        return ok2
          ? { ...text(`Deleted search log entry ${args.id}.`), structuredContent: { deleted: 1 } }
          : toolError(`No search log entry with id ${args.id}.`);
      }
      if (args.all === true) {
        const removed = await clearSearchLog();
        return { ...text(`Cleared the whole search log (${removed} entries).`), structuredContent: { deleted: removed } };
      }
      const { removed, cutoff } = await pruneSearchLog(Number(args.olderThanDays));
      return {
        ...text(`Pruned ${removed} search log entries older than ${args.olderThanDays} days (before ${cutoff}).`),
        structuredContent: { deleted: removed, cutoff },
      };
    }

    case "list_tools": {
      const catalog = await toolCatalog();
      const includeDisabled = args.includeDisabled !== false;
      const shown = includeDisabled ? catalog : catalog.filter((t: any) => !t.disabled);
      const line = (t: any) =>
        `${t.disabled ? "off" : "on "}  ${t.name}${t.generated ? "  (generated)" : ""}${
          UNDISABLEABLE.has(t.name) ? "  [always on]" : ""
        }`;
      return {
        ...text(
          `${shown.length} tools\n\n` + shown.map(line).join("\n"),
        ),
        structuredContent: { tools: shown, locked: [...UNDISABLEABLE] },
      };
    }

    case "toggle_tool": {
      const target = String(args.name ?? "");
      const catalog = await toolCatalog();
      const known = catalog.find((t: any) => t.name === target);
      if (!known) {
        return toolError(
          `No tool named ${target}. Call list_tools to see what exists — generated tools change with the corpus.`,
        );
      }
      // Omitting `enabled` flips it, which is what "toggle" means; passing it
      // makes the call idempotent for a client that wants a known end state.
      const enable = args.enabled === undefined ? known.disabled : Boolean(args.enabled);
      try {
        await setToolDisabled(target, !enable);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : "That tool cannot be changed.");
      }
      return {
        ...text(`${target} is now ${enable ? "enabled" : "disabled"}.`),
        structuredContent: { name: target, enabled: enable },
      };
    }

    case "digest": {
      const digest = await buildDigest({
        window: String(args.window ?? "today"),
        query: args.query,
        ...scopeFrom(args),
        excerpt: args.excerpt,
        limit: args.limit,
      });
      if (!digest) {
        return toolError(
          `Unknown window “${args.window}”. Use one of: ${digestWindows().join(", ")}, or a month like 2026_08.`,
        );
      }
      return {
        ...text(digest.markdown),
        structuredContent: {
          window: digest.window,
          label: digest.label,
          from: digest.fromIso,
          count: digest.count,
          byKind: digest.byKind,
        },
      };
    }

    case "search_memories_between": {
      // Dates arrive as whatever the model produced. Normalising through Date
      // means "2026-01-01" and a full timestamp both work, and an unparseable
      // value is reported rather than silently matching everything.
      const from = new Date(args.from);
      const to = new Date(args.to);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        return toolError("from and to must be ISO-8601 dates, e.g. 2026-01-01.");
      }

      // A date with no time means the WHOLE day, so `to` has to be its last
      // instant. Left as midnight, `from: 2026-08-27, to: 2026-08-27` is a
      // zero-width range that matches nothing — which reads as "no memories
      // that day" rather than as the bug it is. Found by asking for a single
      // day that definitely had memories and getting back zero.
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
      if (dateOnly.test(String(args.to).trim())) {
        to.setUTCHours(23, 59, 59, 999);
      }

      if (from > to) {
        return toolError("from must not be later than to.");
      }
      const memories = await searchInRange({
        fromIso: from.toISOString(),
        toIso: to.toISOString(),
        query: args.query,
        ...scopeFrom(args),
        limit: args.limit ?? 20,
        label: `${args.from} to ${args.to}`,
        source: "mcp",
      });
      const narrowed = describeScope(args);
      const body = memories.length
        ? memories.map((m, i) => `${i + 1}. ${render(m)}`).join("\n\n")
        : `No memories between ${args.from} and ${args.to}${narrowed ? ` in ${narrowed}` : ""}.`;
      return {
        ...text(body),
        structuredContent: {
          from: from.toISOString(),
          to: to.toISOString(),
          matchMode: "keyword",
          ...scopeFrom(args),
          count: memories.length,
          memories,
        },
      };
    }

    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

/**
 * The scope a model asked for, as the shape memory.ts expects.
 *
 * Always returns all four keys, empty when unasked, so `structuredContent` says
 * plainly what a result WAS narrowed by. Reporting only the filters that were
 * set would leave a model unable to tell "the whole corpus has nothing" from
 * "this workspace has nothing" — the exact confusion workspaces introduce.
 */
function scopeFrom(args: Record<string, any>) {
  return {
    kind: args.kind as MemoryKind | undefined,
    workspace: args.workspace ?? "",
    project: args.project ?? "",
    createdBy: args.createdBy ?? "",
  };
}

/** The same scope in prose, for the empty-result sentence. */
function describeScope(args: Record<string, any>): string {
  return [
    args.workspace && `workspace “${args.workspace}”`,
    args.project && `project “${args.project}”`,
    args.createdBy && `memories by ${args.createdBy}`,
    args.kind && `kind ${args.kind}`,
    args.tag && `tag ${args.tag}`,
  ]
    .filter(Boolean)
    .join(", ");
}

async function recall(args: Record<string, any>) {
  // Hybrid by default. Until 0.23.0 this ran a literal keyword scan and said so
  // honestly — but honesty about a limitation is not a substitute for not
  // having it. A model asking by MEANING got "No memories matched" from a
  // corpus that could answer, and an empty result is indistinguishable from a
  // true one. MCP is the only door claude.ai has, so a capability that lived
  // solely on the REST route was invisible to the consumers that matter.
  const result = await recallMemories({
    query: args.query ?? "",
    mode: args.mode,
    ...scopeFrom(args),
    tag: args.tag,
    limit: args.limit ?? 10,
    source: "mcp",
  });

  const { memories, effectiveMode, fallback } = result;
  const scope = describeScope(args);

  const body = memories.length
    ? memories.map((m, i) => `${i + 1}. ${render(m)}`).join("\n\n")
    : `No memories matched${args.query ? ` “${args.query}”` : ""}${scope ? ` in ${scope}` : ""}.` +
      // An empty keyword result is a much weaker signal than an empty hybrid
      // one, and the model cannot tell them apart unless we say so.
      (effectiveMode === "keyword" && args.query
        ? `\n\n(Searched by keyword only${fallback ? ` — ${fallback.reason}` : ""}. ` +
          `A search by meaning may still find something.)`
        : "");

  return {
    ...text(body),
    structuredContent: {
      query: args.query ?? "",
      // Reported, never assumed: this is what ACTUALLY ran, which is not
      // always what was asked for.
      matchMode: effectiveMode,
      requestedMode: result.requestedMode,
      ...(fallback ? { fallback } : {}),
      ...(result.counts ? { counts: result.counts } : {}),
      ...scopeFrom(args),
      count: memories.length,
      memories,
    },
  };
}

// ── JSON-RPC entry point ──────────────────────────────────────────────────────

export async function handleMcp(request: JsonRpcRequest): Promise<unknown | null> {
  const { method, id, params = {} } = request;

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: negotiateProtocol((params as any).protocolVersion),
        // listChanged tells the client the tool list is live — which it is, as
        // writing a memory under a new project adds a tool.
        capabilities: { tools: { listChanged: true } },
        // The real build number, not a hand-maintained constant. A client that
        // reports what it connected to should not report a version that stopped
        // being true eight releases ago.
        serverInfo: { name: INSTANCE_NAME, version: VERSION },
      });

    // Notifications carry no id and MUST NOT be answered — returning a response
    // to one is a protocol violation the client is entitled to reject.
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return ok(id, {});

    case "tools/list": {
      const { tools } = await buildToolList();
      // Strip the private field before it goes on the wire: `_project` is our
      // dispatch aid, not part of the client's contract.
      return ok(id, {
        tools: tools.map(({ _project, ...tool }: any) => tool),
      });
    }

    case "tools/call": {
      const name = String((params as any).name ?? "");
      const args = ((params as any).arguments ?? {}) as Record<string, any>;
      // Hiding a tool from the list is not enough — a client that cached an
      // older list would still be able to call it.
      if ((await disabledTools()).has(name)) {
        return ok(id, toolError(`${name} is switched off for this connector.`));
      }
      try {
        return ok(id, await callTool(name, args));
      } catch (error) {
        // Tool failures are reported inside a successful JSON-RPC result, not
        // as a transport error: the model should see and reason about them.
        const message = error instanceof Error ? error.message : "tool failed";
        return ok(id, toolError(message));
      }
    }

    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}
