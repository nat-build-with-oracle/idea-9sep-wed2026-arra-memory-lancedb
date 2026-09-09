/**
 * The fleet, over MQTT, from inside the corpus.
 *
 * This is the door claude.ai does not otherwise have. claude.ai cannot open an
 * MQTT connection, cannot reach a LAN address, and cannot join a mesh — but it
 * CAN speak MCP to this add-on. So arra-memory holds the broker connection on
 * its behalf: an MCP tool call in a browser becomes a publish on the fleet's
 * broker, and a retained fleet state becomes a table the model can read.
 *
 * ── why this file speaks MQTT rather than proxying the registry's HTTP API ───
 *
 * An earlier version of this file called oracle-registry over HTTP. That works
 * and reuses the registry's dispatch credential, its rate limit and its audit
 * row — but it makes this add-on's fleet surface depend on ANOTHER add-on being
 * installed, running, reachable, and version-matched. A memory server that
 * cannot tell you who is alive because a sibling container is restarting is a
 * memory server with an avoidable dependency. Self-contained wins: the broker
 * is the shared substrate, and both of us are just clients of it.
 *
 * The cost, stated honestly: two publishers now write `<prefix>/<name>/<room>/in`
 * — the registry's dispatch client and this one. That is the exact shape of the
 * drift bug this codebase has shipped four times, so the mitigation is that the
 * topic layout lives in ONE place here (`topics()` below), the shape is asserted
 * in tests, and any change to the contract is a change to that function.
 *
 * ── presence needs no database ───────────────────────────────────────────────
 *
 * Members publish their state RETAINED. So a subscriber that has just connected
 * receives the entire fleet's current state as a burst of retained messages —
 * no table, no sync, no staleness of our own invention. We keep it in a Map and
 * let the broker be the source of truth. If this process restarts, the picture
 * rebuilds itself in milliseconds.
 *
 * Blank `mqtt_url` disables all of it and the tools are not offered at all,
 * rather than offered and always failing.
 */

import mqtt, { type MqttClient } from "mqtt";
import { setting } from "./config";

/** A topic segment that cannot escape its level. Applied to every name and room
 *  BEFORE it is interpolated into a topic — `#` and `+` and `/` are the whole
 *  point: a crafted room could otherwise subscribe or publish across the tree. */
const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

/** The contract, in one place. Anything that changes the wire changes here. */
function topics(prefix: string) {
  return {
    /** Retained, one per member: presence as the registry knows it. */
    lwt: `${prefix}/+/lwt`,
    /** Retained: host, repo, client, version. */
    meta: `${prefix}/+/meta`,
    /** Retained: the chat channel's own liveness. */
    status: `${prefix}/+/status`,
    /** Not retained: replies flowing back from any member's room. */
    out: `${prefix}/+/+/out`,
    /** Where a message TO a member goes. */
    inbox: (name: string, room: string) => `${prefix}/${name}/${room}/in`,
  };
}

export type Member = {
  name: string;
  /** What the member's own LWT says: online | offline | unknown. */
  state: string;
  /** Whether a chat channel is attached and live — separate from `state`,
   *  because a member can be up with no channel, and that is worth seeing. */
  channel?: boolean;
  host?: string;
  client?: string;
  version?: string;
  /** Last time ANY message from this member arrived here. */
  seen?: string;
};

export type Reply = {
  seq: number;
  name: string;
  room: string;
  text: string;
  at: string;
};

const members = new Map<string, Member>();
/** Replies are a short ring, deliberately: this is a live channel, not an inbox.
 *  A durable inbox implies delivery guarantees we do not have and should not
 *  imply — see the tool description. */
const replies: Reply[] = [];
let replySeq = 0;
const REPLY_RING = 200;

let client: MqttClient | null = null;
let connected = false;
let lastError = "";

export function fleetEnabled(): boolean {
  return setting("mqtt_url").trim() !== "";
}

export function fleetStatus() {
  return { enabled: fleetEnabled(), connected, error: lastError, members: members.size };
}

function prefix(): string {
  return (setting("mqtt_prefix") || "oracle").replace(/\/+$/, "");
}

function upsert(name: string, patch: Partial<Member>) {
  const now = new Date().toISOString();
  const cur = members.get(name) ?? { name, state: "unknown" };
  members.set(name, { ...cur, ...patch, seen: now });
}

/**
 * Connect and start listening. Called once at startup when configured.
 *
 * Never throws: a broker that is down must not stop the corpus from serving
 * memories. The failure is recorded and reported through the tools instead, so
 * a model asking "who is alive" is told the truth — that we cannot see — rather
 * than an empty list, which would read as "nobody".
 */
export function startFleet(): void {
  if (!fleetEnabled() || client) return;
  const t = topics(prefix());
  const url = setting("mqtt_url").trim();
  const username = setting("mqtt_username").trim() || undefined;
  const password = setting("mqtt_password").trim() || undefined;

  client = mqtt.connect(url, {
    username,
    password,
    // Stable per instance, so a reconnect resumes its own session rather than
    // racing a ghost of itself.
    clientId: `arra-memory-${setting("instance_name") || "unnamed"}`,
    reconnectPeriod: 5000,
    keepalive: 30,
  });

  client.on("connect", () => {
    connected = true;
    lastError = "";
    // NEVER `#`. Four narrow filters, each anchored to a known depth — the
    // fleet broker carries roughly 109 GB/day of device traffic and a wildcard
    // at the root would pull all of it into this process.
    client!.subscribe([t.lwt, t.meta, t.status, t.out], { qos: 1 });
    console.log(`[fleet] connected ${url}, watching ${prefix()}/+/{lwt,meta,status} and ${prefix()}/+/+/out`);
  });

  client.on("error", (e) => {
    lastError = String(e?.message ?? e);
  });
  client.on("close", () => {
    connected = false;
  });

  client.on("message", (topic, payload) => {
    const parts = topic.split("/");
    // Re-validate depth and prefix even though the broker matched our filter:
    // a wildcard match is not a reason to trust the shape, and every field
    // below indexes by position.
    if (parts[0] !== prefix()) return;
    const body = payload.toString();

    // <prefix>/<name>/lwt — the member's own liveness, retained.
    if (parts.length === 3 && parts[2] === "lwt" && parts[1]) {
      // An EMPTY retained payload means the member cleared its own retain on a
      // clean exit — it left on purpose. A lingering "offline" means the broker
      // published its will: it died. Same word, different fact, so an empty
      // payload removes the row rather than marking it offline.
      if (body === "") {
        members.delete(parts[1]);
        return;
      }
      const s = body.trim().toLowerCase();
      if (s === "online" || s === "offline") upsert(parts[1], { state: s });
      return;
    }

    // <prefix>/<name>/meta — host, repo, client, version. Retained.
    if (parts.length === 3 && parts[2] === "meta" && parts[1]) {
      if (body === "") return;
      try {
        const m = JSON.parse(body) as Record<string, unknown>;
        upsert(parts[1], {
          host: typeof m.host === "string" ? m.host : undefined,
          client: typeof m.client === "string" ? m.client : undefined,
          version: typeof m.version === "string" ? m.version : undefined,
        });
      } catch {
        /* a member publishing junk must not take the listener down */
      }
      return;
    }

    // <prefix>/<name>/status — the chat channel's liveness, retained.
    if (parts.length === 3 && parts[2] === "status" && parts[1]) {
      if (body === "") {
        upsert(parts[1], { channel: false });
        return;
      }
      try {
        const s = JSON.parse(body) as { online?: unknown; client?: unknown };
        // Only a real channel client's word counts. Anything else publishing
        // here is noise or a spoof, and must not create a phantom "chattable"
        // member that a model would then try to talk to.
        if (typeof s.online === "boolean" && typeof s.client === "string") {
          upsert(parts[1], { channel: s.online, client: s.client });
        }
      } catch {
        /* ditto */
      }
      return;
    }

    // <prefix>/<name>/<room>/out — a reply. Depth-exact, so `out/img` and other
    // deeper topics are not mistaken for messages.
    if (parts.length === 4 && parts[3] === "out" && parts[1] && parts[2]) {
      let text = body;
      try {
        const m = JSON.parse(body) as { text?: unknown };
        if (typeof m.text === "string") text = m.text;
      } catch {
        /* a bare string is a valid reply */
      }
      replies.push({
        seq: ++replySeq,
        name: parts[1],
        room: parts[2],
        text,
        at: new Date().toISOString(),
      });
      if (replies.length > REPLY_RING) replies.splice(0, replies.length - REPLY_RING);
    }
  });
}

/** The fleet as the broker currently describes it. */
export function listFleet(): { ok: true; members: Member[] } | { ok: false; error: string } {
  if (!fleetEnabled()) return { ok: false, error: "mqtt_url is not set" };
  if (!connected) {
    return {
      ok: false,
      error: `not connected to the broker${lastError ? ` (${lastError})` : ""} — this means we cannot SEE the fleet, not that it is empty`,
    };
  }
  return { ok: true, members: [...members.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

/**
 * Publish one message into a member's room.
 *
 * Resolves on the broker's PUBACK rather than on handing the bytes to the
 * client library — "sent" should mean the broker has it, not that we asked.
 * The distinction matters because the caller reports success to a human.
 */
export function sendToMember(
  name: string,
  text: string,
  room = "main",
): Promise<{ ok: true; topic: string; id: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    if (!fleetEnabled()) return resolve({ ok: false, error: "mqtt_url is not set" });
    if (!client || !connected) return resolve({ ok: false, error: "not connected to the broker" });
    if (!SEGMENT.test(name)) return resolve({ ok: false, error: `invalid name ${JSON.stringify(name)}` });
    if (!SEGMENT.test(room)) return resolve({ ok: false, error: `invalid room ${JSON.stringify(room)}` });
    if (!text.trim()) return resolve({ ok: false, error: "empty message" });
    if (text.length > 8192) return resolve({ ok: false, error: "message too long (max 8192)" });

    const known = members.get(name);
    if (!known) {
      return resolve({
        ok: false,
        error: `no member named ${name} is visible on the broker — call list_fleet to see who is`,
      });
    }

    const topic = topics(prefix()).inbox(name, room);
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const payload = JSON.stringify({
      text,
      user: setting("instance_name") || "arra-memory",
      id,
    });
    client.publish(topic, payload, { qos: 1 }, (err) => {
      if (err) return resolve({ ok: false, error: `publish failed: ${String(err.message ?? err)}` });
      resolve({ ok: true, topic, id });
    });
  });
}

/** Replies newer than `since`, optionally for one member. */
export function memberReplies(name?: string, since = 0): Reply[] {
  return replies.filter((r) => r.seq > since && (!name || r.name === name));
}
